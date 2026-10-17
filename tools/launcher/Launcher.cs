// Лаунчер LD60: одним exe запускает игру в браузере по умолчанию.
//
// Два режима:
//  1) «Проект»: exe лежит в <проект>\release\ — сервер раздаёт <проект>\dist с диска и при каждой перезагрузке страницы
//     сам проверяет, не изменились ли исходники (src, data, assets, index.html, конфиги); если да — запускает
//     `npm run build` и отдаёт свежую версию. Ошибки сборки показываются прямо на странице.
//  2) «Автономный»: если проекта рядом нет, игра берётся из вшитого в exe dist.zip (версия на момент сборки exe).
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

    // Вшитая копия игры (автономный режим)
    static readonly Dictionary<string, byte[]> Embedded = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);

    // Режим проекта: корень проекта и его dist (null — автономный режим)
    static string projectRoot = null;
    static string distDir = null;
    static readonly object BuildLock = new object();

    static long lastPing = 0;
    static long byeAt = 0;
    static readonly Stopwatch Clock = Stopwatch.StartNew();

    [STAThread]
    static int Main()
    {
        try
        {
            DetectProject();
            if (projectRoot == null) LoadEmbedded();

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
                if (ping == 0 && now > 240000) break;               // браузер так и не открыл страницу (сборка могла идти долго)
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

    // ---------- Режим проекта ----------

    /// Проект лежит на уровень выше exe (release\LD60.exe -> корень с package.json и src).
    static void DetectProject()
    {
        string exeDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        string parent = Path.GetDirectoryName(exeDir);
        if (parent == null) return;
        if (File.Exists(Path.Combine(parent, "package.json")) &&
            File.Exists(Path.Combine(parent, "index.html")) &&
            Directory.Exists(Path.Combine(parent, "src")))
        {
            projectRoot = parent;
            distDir = Path.Combine(parent, "dist");
        }
    }

    static DateTime NewestSourceTime()
    {
        DateTime newest = DateTime.MinValue;
        foreach (string f in new[] { "index.html", "package.json", "tsconfig.json", "vite.config.ts" })
        {
            string p = Path.Combine(projectRoot, f);
            if (File.Exists(p)) newest = Max(newest, File.GetLastWriteTimeUtc(p));
        }
        string skip = Path.DirectorySeparatorChar + "assets" + Path.DirectorySeparatorChar + "source" + Path.DirectorySeparatorChar;
        foreach (string dir in new[] { "src", "data", "assets" })
        {
            string d = Path.Combine(projectRoot, dir);
            if (!Directory.Exists(d)) continue;
            foreach (string f in Directory.GetFiles(d, "*", SearchOption.AllDirectories))
            {
                if (f.IndexOf(skip, StringComparison.OrdinalIgnoreCase) >= 0) continue;
                newest = Max(newest, File.GetLastWriteTimeUtc(f));
            }
        }
        return newest;
    }

    static DateTime Max(DateTime a, DateTime b) { return a > b ? a : b; }

    /// Пересобирает игру, если исходники новее dist. Возвращает текст ошибки сборки или null.
    static string EnsureFresh()
    {
        lock (BuildLock)
        {
            string index = Path.Combine(distDir, "index.html");
            DateTime built = File.Exists(index) ? File.GetLastWriteTimeUtc(index) : DateTime.MinValue;
            if (built >= NewestSourceTime()) return null;

            var psi = new ProcessStartInfo("cmd.exe", "/c npm run build 2>&1")
            {
                WorkingDirectory = projectRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true
            };
            using (var p = Process.Start(psi))
            {
                string output = p.StandardOutput.ReadToEnd();
                p.WaitForExit(180000);
                return p.ExitCode == 0 ? null : output;
            }
        }
    }

    // ---------- Автономный режим ----------

    static void LoadEmbedded()
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
                        Embedded["/" + entry.FullName.Replace((char)92, '/')] = ms.ToArray();
                    }
                }
            }
        }
        if (!Embedded.ContainsKey("/index.html")) throw new InvalidOperationException("В игре нет index.html.");
    }

    // ---------- HTTP ----------

    static byte[] InjectPing(byte[] indexHtml)
    {
        string html = Encoding.UTF8.GetString(indexHtml);
        int i = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        html = i >= 0 ? html.Insert(i, PingScript) : html + PingScript;
        return Encoding.UTF8.GetBytes(html);
    }

    /// Содержимое файла по URL-пути или null.
    static byte[] Load(string path)
    {
        byte[] data = null;
        if (projectRoot != null)
        {
            string full = Path.GetFullPath(Path.Combine(distDir, path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar)));
            string root = Path.GetFullPath(distDir) + Path.DirectorySeparatorChar;
            if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) return null;
            data = File.ReadAllBytes(full);
        }
        else if (!Embedded.TryGetValue(path, out data)) return null;

        return path == "/index.html" ? InjectPing(data) : data;
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

            // Перезагрузка страницы = проверка, не устарела ли сборка
            if (projectRoot != null && path == "/index.html")
            {
                string error = EnsureFresh();
                if (error != null)
                {
                    string page = "<!doctype html><meta charset=utf-8><title>Ошибка сборки</title>" +
                        "<body style=\"background:#0d0f12;color:#ff6b6b;font:14px Consolas,monospace;padding:24px\">" +
                        "<h2>Сборка не удалась</h2><p style=\"color:#ccc\">Исправьте ошибку и перезагрузите страницу.</p><pre>" +
                        WebUtility.HtmlEncode(error) + "</pre>" + PingScript;
                    Reply(ctx, 500, "text/html; charset=utf-8", Encoding.UTF8.GetBytes(page));
                    return;
                }
            }

            byte[] data = Load(path);
            if (data == null) { Reply(ctx, 404, "text/plain", Encoding.UTF8.GetBytes("404")); return; }
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
