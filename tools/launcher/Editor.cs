// LD60Editor: один exe — редактор уровней в браузере по умолчанию.
//
// Что делает: поднимает локальный сервер, отдаёт страницу редактора (и игру, чтобы кнопка «Играть» запускала уровень сразу) и API проекта:
//   GET  /api/ld60/config        — тайлы, спрайты, мобы, каталог объектов, фоны и все уровни из <проект>\data
//   GET  /api/ld60/level?id=     — один уровень с диска (игра по ?live=1 берёт свежую версию)
//   POST /api/ld60/level/save    — записать уровень в <проект>\data\levels\<файл>.json
//   POST /api/ld60/level/delete  — удалить файл уровня
//   GET  /ld60-assets/<путь>     — картинки спрайтов из <проект>\assets\sprites
// Проект ищется так: рядом с exe или на уровень выше (release\LD60Editor.exe), иначе спрашивает папку (и запоминает).
// Страницы: если у проекта есть исходники (src, package.json) — отдаётся <проект>\dist и сам пересобирается (npm run build), когда код изменился;
// иначе — вшитая в exe копия (dist.zip). Сервер завершается, когда вкладку с редактором закрыли.
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
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class EditorLauncher
{
    const string PingScript =
        "<script>(function(){var id=Math.random().toString(36).slice(2);var p=function(){fetch('/__ping?id='+id).catch(function(){})};p();setInterval(p,2000);" +
        "addEventListener('pagehide',function(){navigator.sendBeacon('/__bye?id='+id)})})();</script>";

    static readonly Dictionary<string, string> Mime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        { ".html", "text/html; charset=utf-8" }, { ".js", "text/javascript; charset=utf-8" },
        { ".mjs", "text/javascript; charset=utf-8" }, { ".css", "text/css; charset=utf-8" },
        { ".json", "application/json; charset=utf-8" }, { ".png", "image/png" }, { ".jpg", "image/jpeg" },
        { ".svg", "image/svg+xml" }, { ".ico", "image/x-icon" }, { ".wasm", "application/wasm" },
        { ".mp3", "audio/mpeg" }, { ".ogg", "audio/ogg" }, { ".wav", "audio/wav" }, { ".woff2", "font/woff2" },
        { ".ttf", "font/ttf" }, { ".txt", "text/plain; charset=utf-8" }, { ".map", "application/json" }
    };

    static readonly Dictionary<string, byte[]> Embedded = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
    static string projectRoot = null;   // папка с data\ и assets\
    static string distDir = null;       // режим исходников: <проект>\dist (null — вшитая копия)
    static readonly object BuildLock = new object();
    // Открытые страницы (id -> время последнего пинга). Сервер живёт, пока открыта хоть одна: вкладка в фоне пингует редко,
    // поэтому закрытие одной вкладки (например, игры) не должно останавливать сервер, пока открыта другая.
    static readonly Dictionary<string, long> Pages = new Dictionary<string, long>();
    static bool everPinged = false;
    static long lastBye = 0;
    const long PageTimeout = 20 * 60 * 1000; // страница без пинга столько — считается закрытой
    static readonly Stopwatch Clock = Stopwatch.StartNew();

    [STAThread]
    static int Main()
    {
        try
        {
            projectRoot = FindProject();
            if (projectRoot == null) return 0;
            // Вшитая копия редактора есть всегда. Пересборка исходников (npm run build) — только если есть сами исходники и установлен Node.js;
            // у тех, у кого Node нет, работает вшитая копия — без ошибок про npm.
            LoadEmbedded();
            if (File.Exists(Path.Combine(projectRoot, "package.json")) && Directory.Exists(Path.Combine(projectRoot, "src")) &&
                File.Exists(Path.Combine(projectRoot, "editor.html")) && HasNpm())
                distDir = Path.Combine(projectRoot, "dist");

            int port = FreePort();
            var listener = new HttpListener();
            listener.Prefixes.Add("http://127.0.0.1:" + port + "/");
            listener.Start();
            new Thread(() => AcceptLoop(listener)) { IsBackground = true }.Start();
            Process.Start(new ProcessStartInfo("http://127.0.0.1:" + port + "/editor.html") { UseShellExecute = true });

            while (true)
            {
                Thread.Sleep(500);
                long now = Clock.ElapsedMilliseconds;
                bool empty;
                lock (Pages)
                {
                    var dead = new List<string>();
                    foreach (var kv in Pages) if (now - kv.Value > PageTimeout) dead.Add(kv.Key);
                    foreach (string id in dead) Pages.Remove(id);
                    empty = Pages.Count == 0;
                }
                if (!everPinged && now > 240000) break;                  // браузер так и не открыл страницу
                if (everPinged && empty && now - lastBye > 5000) break;  // все страницы закрыты
            }
            listener.Stop();
            return 0;
        }
        catch (Exception e)
        {
            MessageBox.Show("Не удалось запустить редактор:\n" + e.Message, "LD60 Editor", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    // ---------- Проект ----------

    static bool IsProject(string dir)
    {
        return dir != null && Directory.Exists(Path.Combine(dir, "data", "levels")) && File.Exists(Path.Combine(dir, "data", "tiles", "tiles.json"));
    }

    static string SettingsFile()
    {
        string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "LD60Editor");
        Directory.CreateDirectory(dir);
        return Path.Combine(dir, "project.txt");
    }

    static string FindProject()
    {
        string exeDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        foreach (string dir in new[] { exeDir, Path.GetDirectoryName(exeDir) })
            if (IsProject(dir)) return dir;
        try
        {
            string saved = File.Exists(SettingsFile()) ? File.ReadAllText(SettingsFile()).Trim() : null;
            if (IsProject(saved)) return saved;
        }
        catch { }
        using (var dlg = new FolderBrowserDialog())
        {
            dlg.Description = "Выберите папку проекта LD60 (внутри должны быть data и assets)";
            while (dlg.ShowDialog() == DialogResult.OK)
            {
                if (IsProject(dlg.SelectedPath))
                {
                    try { File.WriteAllText(SettingsFile(), dlg.SelectedPath); } catch { }
                    return dlg.SelectedPath;
                }
                MessageBox.Show("В этой папке нет data\\levels и data\\tiles\\tiles.json — это не проект LD60.", "LD60 Editor", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
        return null;
    }

    // ---------- Страницы редактора и игры ----------

    static void LoadEmbedded()
    {
        var asm = Assembly.GetExecutingAssembly();
        using (var res = asm.GetManifestResourceStream("dist.zip"))
        {
            if (res == null) throw new InvalidOperationException("В exe не вшит редактор (dist.zip).");
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
        if (!Embedded.ContainsKey("/editor.html")) throw new InvalidOperationException("В сборке нет editor.html.");
    }

    /// Установлен ли Node.js (npm в PATH).
    static bool HasNpm()
    {
        try
        {
            var psi = new ProcessStartInfo("cmd.exe", "/c where npm") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            using (var p = Process.Start(psi))
            {
                p.StandardOutput.ReadToEnd();
                p.WaitForExit(10000);
                return p.ExitCode == 0;
            }
        }
        catch { return false; }
    }

    static DateTime NewestSourceTime()
    {
        DateTime newest = DateTime.MinValue;
        foreach (string f in new[] { "index.html", "editor.html", "editor-legacy.html", "package.json", "tsconfig.json", "vite.config.ts" })
        {
            string p = Path.Combine(projectRoot, f);
            if (File.Exists(p)) newest = Max(newest, File.GetLastWriteTimeUtc(p));
        }
        char sep = Path.DirectorySeparatorChar;
        string skipSource = sep + "assets" + sep + "source" + sep;
        string skipLevels = sep + "data" + sep + "levels" + sep; // уровни отдаёт API — сохранение уровня не требует пересборки
        foreach (string dir in new[] { "src", "data", "assets" })
        {
            string d = Path.Combine(projectRoot, dir);
            if (!Directory.Exists(d)) continue;
            foreach (string f in Directory.GetFiles(d, "*", SearchOption.AllDirectories))
            {
                if (f.IndexOf(skipSource, StringComparison.OrdinalIgnoreCase) >= 0 || f.IndexOf(skipLevels, StringComparison.OrdinalIgnoreCase) >= 0) continue;
                newest = Max(newest, File.GetLastWriteTimeUtc(f));
            }
        }
        return newest;
    }

    static DateTime Max(DateTime a, DateTime b) { return a > b ? a : b; }

    /// Пересобирает страницы, если исходники новее dist. Возвращает текст ошибки сборки или null.
    static string EnsureFresh()
    {
        lock (BuildLock)
        {
            string index = Path.Combine(distDir, "editor.html");
            DateTime built = File.Exists(index) ? File.GetLastWriteTimeUtc(index) : DateTime.MinValue;
            if (built >= NewestSourceTime()) return null;
            var psi = new ProcessStartInfo("cmd.exe", "/c npm run build 2>&1")
            {
                WorkingDirectory = projectRoot, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true
            };
            using (var p = Process.Start(psi))
            {
                string output = p.StandardOutput.ReadToEnd();
                p.WaitForExit(180000);
                return p.ExitCode == 0 ? null : output;
            }
        }
    }

    static byte[] LoadPage(string path)
    {
        byte[] data;
        if (distDir != null)
        {
            string full = Path.GetFullPath(Path.Combine(distDir, path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar)));
            string root = Path.GetFullPath(distDir) + Path.DirectorySeparatorChar;
            if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) return null;
            data = File.ReadAllBytes(full);
        }
        else if (!Embedded.TryGetValue(path, out data)) return null;

        if (path == "/editor.html" || path == "/index.html")
        {
            string html = Encoding.UTF8.GetString(data);
            int i = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
            data = Encoding.UTF8.GetBytes(i >= 0 ? html.Insert(i, PingScript) : html + PingScript);
        }
        return data;
    }

    // ---------- API проекта ----------

    static string ReadText(string path)
    {
        string t = File.ReadAllText(path, Encoding.UTF8);
        return t.Length > 0 && t[0] == '﻿' ? t.Substring(1) : t;
    }

    static string Q(string s) { return new JavaScriptSerializer().Serialize(s); }

    static string ReadJsonOr(string path, string fallback)
    {
        return File.Exists(path) ? ReadText(path) : fallback;
    }

    static string BuildConfig()
    {
        string data = Path.Combine(projectRoot, "data");
        var sb = new StringBuilder();
        sb.Append("{\"ld60Path\":").Append(Q(projectRoot));
        sb.Append(",\"tiles\":").Append(ReadJsonOr(Path.Combine(data, "tiles", "tiles.json"), "{\"tile_size\":32,\"tiles\":[]}"));
        sb.Append(",\"sprites\":").Append(ReadJsonOr(Path.Combine(data, "sprites", "sprites.json"), "{\"sprites\":[]}"));
        sb.Append(",\"enemies\":").Append(ReadJsonOr(Path.Combine(data, "enemies", "enemies.json"), "[]"));
        sb.Append(",\"bosses\":").Append(ReadJsonOr(Path.Combine(data, "bosses", "bosses.json"), "[]"));
        sb.Append(",\"placeables\":").Append(ReadJsonOr(Path.Combine(data, "objects", "placeables.json"), "{\"version\":\"0\",\"items\":[],\"decor\":[],\"threads\":[],\"objects\":[]}"));
        sb.Append(",\"backgrounds\":[");
        AppendFiles(sb, Path.Combine(data, "backgrounds"), false);
        sb.Append("],\"levels\":[");
        AppendFiles(sb, Path.Combine(data, "levels"), true);
        sb.Append("]}");
        return sb.ToString();
    }

    static void AppendFiles(StringBuilder sb, string dir, bool wrap)
    {
        if (!Directory.Exists(dir)) return;
        bool first = true;
        foreach (string f in Directory.GetFiles(dir, "*.json"))
        {
            if (!first) sb.Append(',');
            first = false;
            string text = ReadText(f);
            if (wrap) sb.Append("{\"filename\":").Append(Q(Path.GetFileName(f))).Append(",\"data\":").Append(text).Append('}');
            else sb.Append(text);
        }
    }

    static string FindLevelText(string id)
    {
        string dir = Path.Combine(projectRoot, "data", "levels");
        var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        foreach (string f in Directory.GetFiles(dir, "*.json"))
        {
            string text = ReadText(f);
            try
            {
                var obj = json.DeserializeObject(text) as Dictionary<string, object>;
                if (obj != null && obj.ContainsKey("id") && string.Equals(obj["id"] as string, id, StringComparison.Ordinal)) return text;
            }
            catch { }
        }
        return null;
    }

    static string SafeLevelFile(string filename)
    {
        string name = Path.GetFileName(filename ?? "");
        if (string.IsNullOrEmpty(name) || !name.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Недопустимое имя файла уровня");
        return Path.Combine(projectRoot, "data", "levels", name);
    }

    static string ReadBody(HttpListenerRequest req)
    {
        using (var r = new StreamReader(req.InputStream, Encoding.UTF8)) return r.ReadToEnd();
    }

    static void HandleApi(HttpListenerContext ctx, string path)
    {
        var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        try
        {
            if (path == "/api/ld60/config" && ctx.Request.HttpMethod == "GET")
            {
                Reply(ctx, 200, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(BuildConfig()));
                return;
            }
            if (path == "/api/ld60/level" && ctx.Request.HttpMethod == "GET")
            {
                string text = FindLevelText(ctx.Request.QueryString["id"] ?? "");
                if (text == null) { Reply(ctx, 404, "application/json", Encoding.UTF8.GetBytes("{\"error\":\"level not found\"}")); return; }
                Reply(ctx, 200, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(text));
                return;
            }
            if (path == "/api/ld60/level/save" && ctx.Request.HttpMethod == "POST")
            {
                var body = json.DeserializeObject(ReadBody(ctx.Request)) as Dictionary<string, object>;
                string text = body != null && body.ContainsKey("text") ? body["text"] as string : null;
                string filename = body != null && body.ContainsKey("filename") ? body["filename"] as string : null;
                if (text == null) throw new InvalidOperationException("Нет text");
                var level = json.DeserializeObject(text) as Dictionary<string, object>; // проверка, что это JSON с id
                if (level == null || !level.ContainsKey("id")) throw new InvalidOperationException("В уровне нет id");
                if (string.IsNullOrEmpty(filename)) filename = level["id"] + ".json";
                string target = SafeLevelFile(filename);
                File.WriteAllText(target, text, new UTF8Encoding(false));
                Reply(ctx, 200, "application/json", Encoding.UTF8.GetBytes("{\"ok\":true,\"filename\":" + Q(Path.GetFileName(target)) + "}"));
                return;
            }
            if (path == "/api/ld60/level/delete" && ctx.Request.HttpMethod == "POST")
            {
                var body = json.DeserializeObject(ReadBody(ctx.Request)) as Dictionary<string, object>;
                string target = SafeLevelFile(body != null && body.ContainsKey("filename") ? body["filename"] as string : null);
                if (File.Exists(target)) File.Delete(target);
                Reply(ctx, 200, "application/json", Encoding.UTF8.GetBytes("{\"ok\":true}"));
                return;
            }
            Reply(ctx, 404, "application/json", Encoding.UTF8.GetBytes("{\"error\":\"unknown api\"}"));
        }
        catch (Exception e)
        {
            Reply(ctx, 400, "application/json; charset=utf-8", Encoding.UTF8.GetBytes("{\"error\":" + Q(e.Message) + "}"));
        }
    }

    static bool ServeAsset(HttpListenerContext ctx, string path)
    {
        string rel = Uri.UnescapeDataString(path.Substring("/ld60-assets/".Length)).Replace('/', Path.DirectorySeparatorChar);
        foreach (string baseDir in new[] { Path.Combine(projectRoot, "assets", "sprites"), Path.Combine(projectRoot, "assets") })
        {
            string full = Path.GetFullPath(Path.Combine(baseDir, rel));
            if (!full.StartsWith(Path.GetFullPath(baseDir) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) continue;
            string mime;
            if (!Mime.TryGetValue(Path.GetExtension(full), out mime)) mime = "application/octet-stream";
            Reply(ctx, 200, mime, File.ReadAllBytes(full));
            return true;
        }
        return false;
    }

    // ---------- HTTP ----------

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
            if (path == "/__ping" || path == "/__bye")
            {
                string id = ctx.Request.QueryString["id"] ?? "";
                lock (Pages)
                {
                    if (path == "/__ping") { Pages[id] = Clock.ElapsedMilliseconds; everPinged = true; }
                    else { Pages.Remove(id); lastBye = Clock.ElapsedMilliseconds; }
                }
                Reply(ctx, 204, null, null);
                return;
            }
            if (path.StartsWith("/api/ld60/")) { HandleApi(ctx, path); return; }
            if (path.StartsWith("/ld60-assets/"))
            {
                if (!ServeAsset(ctx, path)) Reply(ctx, 404, "text/plain", Encoding.UTF8.GetBytes("404"));
                return;
            }
            if (path == "/") path = "/editor.html";

            if (distDir != null && (path == "/editor.html" || path == "/index.html"))
            {
                string error = EnsureFresh();
                if (error != null && Embedded.ContainsKey("/editor.html"))
                {
                    distDir = null; // сборка не удалась (нет зависимостей, ошибка в коде) — работаем с вшитой копией
                    error = null;
                }
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

            byte[] data = LoadPage(path);
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
