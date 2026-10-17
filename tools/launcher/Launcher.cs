// Лаунчер LD60: одним exe запускает игру в браузере по умолчанию.
// Собранная игра (dist.zip) вшита в exe как ресурс и раздаётся из памяти встроенным HTTP-сервером на 127.0.0.1.
// Сервер сам завершается, когда вкладку с игрой закрыли (страница шлёт heartbeat на /__ping).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Launcher
{
    const string PingScript =
        "<script>(function(){var p=function(){fetch('/__ping').catch(function(){})};p();setInterval(p,2000);" +
        "addEventListener('pagehide',function(){navigator.sendBeacon('/__bye')})})();</script>";

    static readonly Dictionary<string, string> Mime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        { ".html", "text/html; charset=utf-8" }, { ".js", "text/javascript; charset=utf-8" },
        { ".mjs", "text/javascript; charset=utf-8" }, { ".css", "text/css; charset=utf-8" },
        { ".json", "application/json; charset=utf-8" }, { ".png", "image/png" }, { ".jpg", "image/jpeg" },
        { ".svg", "image/svg+xml" }, { ".ico", "image/x-icon" }, { ".wasm", "application/wasm" },
        { ".mp3", "audio/mpeg" }, { ".ogg", "audio/ogg" }, { ".wav", "audio/wav" }, { ".woff2", "font/woff2" },
        { ".txt", "text/plain; charset=utf-8" }, { ".map", "application/json" }
    };

    static readonly Dictionary<string, byte[]> Files = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
    static long lastPing = 0;      // Environment.TickCount64 нет в .NET 4.x — используем Stopwatch
    static long byeAt = 0;
    static readonly Stopwatch Clock = Stopwatch.StartNew();

    [STAThread]
    static int Main()
    {
        try
        {
            LoadFiles();
            int port = FreePort();
            var listener = new HttpListener();
            listener.Prefixes.Add("http://127.0.0.1:" + port + "/");
            listener.Start();

            var accept = new Thread(() => AcceptLoop(listener)) { IsBackground = true };
            accept.Start();

            Process.Start(new ProcessStartInfo("http://127.0.0.1:" + port + "/") { UseShellExecute = true });

            // Ждём закрытия вкладки: пинга нет давно (вкладка в фоне может слать раз в минуту) или пришёл /__bye без возврата
            while (true)
            {
                Thread.Sleep(500);
                long now = Clock.ElapsedMilliseconds;
                long ping = Interlocked.Read(ref lastPing);
                long bye = Interlocked.Read(ref byeAt);
                if (ping == 0 && now > 60000) break;                // браузер так и не открыл страницу
                if (ping != 0 && now - ping > 150000) break;        // давно нет heartbeat
                if (bye != 0 && ping < bye && now - bye > 4000) break; // вкладку закрыли и не перезагрузили
            }
            listener.Stop();
            return 0;
        }
        catch (Exception e)
        {
            MessageBox.Show("Не удалось запустить игру:\n" + e.Message, "LD60", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    static void LoadFiles()
    {
        var asm = Assembly.GetExecutingAssembly();
        using (var res = asm.GetManifestResourceStream("dist.zip"))
        {
            if (res == null) throw new InvalidOperationException("В exe не вшита игра (dist.zip).");
            using (var zip = new ZipArchive(res, ZipArchiveMode.Read))
            {
                foreach (var entry in zip.Entries)
                {
                    if (entry.Length == 0 || entry.FullName.EndsWith("/")) continue;
                    using (var s = entry.Open())
                    using (var ms = new MemoryStream())
                    {
                        s.CopyTo(ms);
                        Files["/" + entry.FullName.Replace((char)92, '/')] = ms.ToArray();
                    }
                }
            }
        }
        byte[] index;
        if (!Files.TryGetValue("/index.html", out index)) throw new InvalidOperationException("В игре нет index.html.");
        string html = Encoding.UTF8.GetString(index);
        int i = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        html = i >= 0 ? html.Insert(i, PingScript) : html + PingScript;
        Files["/index.html"] = Encoding.UTF8.GetBytes(html);
    }

    static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        int port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    static void AcceptLoop(HttpListener listener)
    {
        while (listener.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = listener.GetContext(); }
            catch { return; }
            ThreadPool.QueueUserWorkItem(_ => Handle(ctx));
        }
    }

    static void Handle(HttpListenerContext ctx)
    {
        try
        {
            string path = Uri.UnescapeDataString(ctx.Request.Url.AbsolutePath);
            if (path == "/__ping") { Interlocked.Exchange(ref lastPing, Clock.ElapsedMilliseconds); Reply(ctx, 204, null, null); return; }
            if (path == "/__bye") { Interlocked.Exchange(ref byeAt, Clock.ElapsedMilliseconds); Reply(ctx, 204, null, null); return; }
            if (path == "/") path = "/index.html";

            byte[] data;
            if (!Files.TryGetValue(path, out data)) { Reply(ctx, 404, "text/plain", Encoding.UTF8.GetBytes("404")); return; }
            string mime;
            if (!Mime.TryGetValue(Path.GetExtension(path), out mime)) mime = "application/octet-stream";
            Reply(ctx, 200, mime, data);
        }
        catch { try { ctx.Response.Abort(); } catch { } }
    }

    static void Reply(HttpListenerContext ctx, int code, string mime, byte[] body)
    {
        ctx.Response.StatusCode = code;
        if (mime != null) ctx.Response.ContentType = mime;
        ctx.Response.AddHeader("Cache-Control", "no-store");
        if (body != null) { ctx.Response.ContentLength64 = body.Length; ctx.Response.OutputStream.Write(body, 0, body.Length); }
        ctx.Response.OutputStream.Close();
    }
}
