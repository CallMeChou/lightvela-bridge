using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LightVelaBridge {
public static class Program {
    [STAThread]
    public static void Main() {
        var root = AppDomain.CurrentDomain.BaseDirectory;
        var vendor = Path.Combine(root,"vendor","webview2");
        Environment.SetEnvironmentVariable("PATH", vendor + ";" + Environment.GetEnvironmentVariable("PATH"));
        AppDomain.CurrentDomain.AssemblyResolve += (sender, args) => {
            var name = new System.Reflection.AssemblyName(args.Name).Name;
            if (name != "Microsoft.Web.WebView2.Core" && name != "Microsoft.Web.WebView2.WinForms") return null;
            return System.Reflection.Assembly.LoadFrom(Path.Combine(vendor,name + ".dll"));
        };
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        try { Application.Run(new MainWindow(root, "node.exe")); }
        catch { MessageBox.Show("工具启动失败。请检查 Node.js 和 Edge WebView2 Runtime 是否安装。", "LightVela Bridge"); }
    }
}
public static class Json {
    public static string Encode(object value) { return new JavaScriptSerializer().Serialize(value); }
    public static Dictionary<string, object> Decode(string value) { return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(value.TrimStart('\uFEFF')); }
    public static string Text(Dictionary<string, object> d, string key, string fallback = "") { return d.ContainsKey(key) && d[key] != null ? Convert.ToString(d[key]) : fallback; }
}

public static class Vault {
    public static string Protect(string value) {
        if (String.IsNullOrEmpty(value)) return "";
        return BitConverter.ToString(ProtectedData.Protect(Encoding.Unicode.GetBytes(value), null, DataProtectionScope.CurrentUser)).Replace("-", "").ToLowerInvariant();
    }
    public static string Unprotect(string value) {
        if (String.IsNullOrEmpty(value)) return "";
        var bytes = Enumerable.Range(0, value.Length / 2).Select(i => Convert.ToByte(value.Substring(i * 2, 2), 16)).ToArray();
        return Encoding.Unicode.GetString(ProtectedData.Unprotect(bytes, null, DataProtectionScope.CurrentUser));
    }
    public static void Save(string path, string token, string instance, int port) {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        var temp = path + ".new";
        File.WriteAllText(temp, Json.Encode(new { token = Protect(token), instanceId = instance, port = port }), new UTF8Encoding(true));
        if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path);
    }
}

// A separate browser profile belongs only to this tool. Existing browser profiles,
// cookies and credentials are never inspected or imported.
public class LoginWindow : Form {
    readonly WebView2 browser = new WebView2();
    readonly Label hint = new Label();
    readonly Timer timer = new Timer();
    readonly string profile;
    readonly Uri origin;
    readonly bool freshLogin;
    bool polling;
    string lastRejectedToken = "";
    public Func<string, Task<bool>> ValidateToken { get; set; }
    public string CapturedToken { get; private set; }
    public LoginWindow(string profilePath) : this(profilePath, new Uri("https://lightvela.com/agents")) { }
    public LoginWindow(string profilePath, bool resetLogin) : this(profilePath, new Uri("https://lightvela.com/agents"), resetLogin) { }
    internal LoginWindow(string profilePath, Uri site) : this(profilePath, site, false) { }
    internal LoginWindow(string profilePath, Uri site, bool resetLogin) {
        profile = profilePath; origin = site; freshLogin = resetLogin;
        Text = "登录 LightVela · 登录成功后自动返回";
        Size = new Size(1100, 800); MinimumSize = new Size(700, 550);
        StartPosition = FormStartPosition.CenterParent;
        hint.Text = "请在下方登录 LightVela。完成后将自动获取并加密保存登录凭证。";
        hint.Dock = DockStyle.Top; hint.Height = 44; hint.Padding = new Padding(12);
        browser.Dock = DockStyle.Fill; Controls.Add(browser); Controls.Add(hint);
        timer.Interval = 1200;
        timer.Tick += async (s, e) => await CaptureToken();
        Shown += async (s, e) => {
            try {
                var env = await CoreWebView2Environment.CreateAsync(null, profile);
                await browser.EnsureCoreWebView2Async(env);
                if (IsDisposed) return;
                browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
                browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                browser.CoreWebView2.NewWindowRequested += (sender, args) => {
                    args.Handled = true;
                    Uri destination;
                    if (Uri.TryCreate(args.Uri, UriKind.Absolute, out destination) && destination.Scheme == "https") browser.CoreWebView2.Navigate(args.Uri);
                };
                browser.CoreWebView2.PermissionRequested += (sender, args) => { args.State = CoreWebView2PermissionState.Deny; };
                browser.CoreWebView2.DownloadStarting += (sender, args) => { args.Cancel = true; };
                browser.CoreWebView2.NavigationCompleted += (sender, args) => {
                    if (!args.IsSuccess) hint.Text = "页面加载失败，请检查网络，关闭此窗口后重试。";
                };
                // Finish clearing this tool's isolated profile before any page or
                // token polling can restore the previous account.
                if (freshLogin) {
                    hint.Text = "正在退出旧账号，清理本工具的登录状态…";
                    await browser.CoreWebView2.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.AllProfile);
                    if (IsDisposed) return;
                    hint.Text = "旧登录状态已清除，请选择正确的 LightVela 账号重新登录。";
                }
                browser.CoreWebView2.Navigate(origin.AbsoluteUri);
                timer.Start();
            } catch { hint.Text = "登录窗口启动失败。请确认已安装 Microsoft Edge WebView2 Runtime，或使用主窗口的手动填写入口。"; }
        };
        FormClosed += (s, e) => { timer.Stop(); timer.Dispose(); browser.Dispose(); };
    }
    async Task CaptureToken() {
        if (polling || IsDisposed || browser.CoreWebView2 == null) return;
        polling = true;
        try {
            // Check location *inside* the script as well, to close navigation races.
            var js = "(() => { if (location.origin !== " + Json.Encode(origin.GetLeftPart(UriPartial.Authority)) + ") return null; return localStorage.getItem('vela.lightvela.session-token.v1') || localStorage.getItem('lightclaw-auth-token-v1') || null; })()";
            var raw = await browser.CoreWebView2.ExecuteScriptAsync(js);
            var token = new JavaScriptSerializer().Deserialize<string>(raw);
            if (!String.IsNullOrWhiteSpace(token) && token.Length <= 32768 && token.IndexOfAny(new[] {'\r', '\n'}) < 0 && !IsDisposed) {
                token = token.Trim();
                if (token == lastRejectedToken) return;
                hint.Text = "已获取登录凭证，正在校验…";
                if (ValidateToken != null && !await ValidateToken(token)) {
                    if (!IsDisposed) hint.Text = "登录校验未通过。请在页面退出账号后重新登录，或关闭窗口稍后重试。";
                    lastRejectedToken = token; return;
                }
                if (IsDisposed) return;
                CapturedToken = token.Trim(); timer.Stop(); DialogResult = DialogResult.OK; Close();
            }
        } catch { /* navigation can invalidate an in-flight script; next tick retries */ }
        finally { polling = false; }
    }
}

public class MainWindow : Form {
    readonly string root, node, stateDir, stateFile;
    readonly TextBox tokenBox = new TextBox();
    readonly ComboBox instanceBox = new ComboBox();
    readonly NumericUpDown portBox = new NumericUpDown();
    readonly Label status = new Label();
    readonly Label account = new Label();
    readonly List<Button> actions = new List<Button>();
    readonly Button login;
    Process proxy;
    string runningKey = "", bridgeId = "";
    bool busy;
    bool closed;
    public MainWindow(string directory, string nodePath) : this(directory, nodePath,
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "LightVelaBridge")) { }
    internal MainWindow(string directory, string nodePath, string appStateDir) {
        root = directory; node = nodePath;
        stateDir = appStateDir;
        stateFile = Path.Combine(stateDir, "settings.json");
        Text = "LightVela Bridge"; Size = new Size(700, 610); MinimumSize = Size;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(22, 25, 34); ForeColor = Color.FromArgb(235, 238, 245);
        Font = new Font("Microsoft YaHei UI", 10); AutoScaleMode = AutoScaleMode.Dpi;
        Label title = LabelAt("LightVela Bridge", 28, 22, 630, 45); title.Font = new Font(Font.FontFamily, 22, FontStyle.Bold);
        LabelAt("登录 → 自动保存凭证 → 启动反代 / 导入 CC Switch", 30, 76, 620, 30);
        login = ButtonAt("登录并获取 Token", 30, 120, 195, async () => await Login(), Color.FromArgb(76, 92, 220));
        ButtonAt("退出并重新登录", 235, 120, 200, async () => await LogoutAndLogin(), Color.FromArgb(125, 66, 80));
        ButtonAt("校验 / 刷新实例", 445, 120, 190, async () => await ValidateSession(), Color.FromArgb(53, 61, 78));
        account.SetBounds(30, 176, 610, 35); account.Text = "尚未校验登录状态"; account.ForeColor = Color.FromArgb(155, 163, 180); Controls.Add(account);
        LabelAt("实例", 30, 226, 100, 30);
        instanceBox.SetBounds(145, 222, 490, 30); instanceBox.DropDownStyle = ComboBoxStyle.DropDown;
        instanceBox.Items.Add(new Instance("", "自动选择运行中的实例")); instanceBox.SelectedIndex = 0; Controls.Add(instanceBox);
        LabelAt("本地端口", 30, 273, 110, 30);
        portBox.SetBounds(145, 269, 120, 30); portBox.Minimum = 1024; portBox.Maximum = 65535; portBox.Value = 8790; Controls.Add(portBox);
        LabelAt("模型：auto", 320, 273, 220, 30);
        LabelAt("Token（备用）", 30, 319, 120, 30);
        tokenBox.SetBounds(145, 315, 490, 30); tokenBox.UseSystemPasswordChar = true; Controls.Add(tokenBox);
        LabelAt("通常无需手动填写；登录成功后自动加密保存在本机。", 145, 350, 490, 26).Font = new Font(Font.FontFamily, 9);
        ButtonAt("启动 / 更新反代", 30, 391, 185, async () => { await StartProxy(); }, Color.FromArgb(76, 92, 220));
        ButtonAt("一键导入 CC Switch", 230, 391, 210, async () => await Import(), Color.FromArgb(43, 154, 112));
        ButtonAt("打开 CC Switch", 455, 391, 180, async () => { await Task.Yield(); OpenCCSwitch(); }, Color.FromArgb(53, 61, 78));
        ButtonAt("停止反代", 30, 447, 185, async () => { await Task.Yield(); StopProxy(); SetStatus("反代已停止。", true); }, Color.FromArgb(53, 61, 78));
        LabelAt("导入时请退出 CC Switch（含托盘）。成功前不会修改供应商配置。", 230, 447, 410, 44).Font = new Font(Font.FontFamily, 9);
        status.SetBounds(30, 505, 605, 58); status.Text = "点击上方登录按钮开始。"; status.ForeColor = Color.FromArgb(155, 163, 180); Controls.Add(status);
        LoadState();
        FormClosing += (s, e) => {
            if (busy) { e.Cancel = true; SetStatus("操作正在进行，请等待结束后关闭。", false); return; }
            if (ProxyAlive() && MessageBox.Show(this, "退出将停止本地反代，正在使用它的会话将断开。确定退出？", "退出 LightVela Bridge", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) { e.Cancel = true; return; }
            StopProxy(); closed = true;
        };
    }
    Label LabelAt(string text, int x, int y, int w, int h) { var l = new Label { Text = text }; l.SetBounds(x,y,w,h); Controls.Add(l); return l; }
    Button ButtonAt(string text, int x, int y, int w, Func<Task> action, Color color) {
        var b = new Button { Text = text, FlatStyle = FlatStyle.Flat, BackColor = color, ForeColor = Color.White };
        b.SetBounds(x,y,w,42); Controls.Add(b); actions.Add(b);
        b.Click += async (s,e) => {
            if (busy) return;
            busy = true; foreach (var a in actions) a.Enabled = false;
            tokenBox.Enabled = instanceBox.Enabled = portBox.Enabled = false;
            try { await action(); }
            catch { SetStatus("操作失败，请检查网络、程序路径及 CC Switch 状态后重试。", false); }
            finally { busy = false; if (!closed) { foreach (var a in actions) a.Enabled = true; tokenBox.Enabled = instanceBox.Enabled = portBox.Enabled = true; } }
        }; return b;
    }
    void SetStatus(string message, bool ok) { status.Text = message; status.ForeColor = ok ? Color.FromArgb(145,220,174) : Color.FromArgb(255,145,145); }
    string InstanceId { get { var item = instanceBox.SelectedItem as Instance; return item != null && instanceBox.Text == item.ToString() ? item.Id : instanceBox.Text.Trim(); } }
    void LoadState() {
        if (!File.Exists(stateFile)) return;
        try {
            var data = Json.Decode(File.ReadAllText(stateFile)); tokenBox.Text = Vault.Unprotect(Json.Text(data,"token"));
            int port; if (Int32.TryParse(Json.Text(data,"port"),out port) && port >= 1024 && port <= 65535) portBox.Value = port;
            var id = Json.Text(data,"instanceId"); if (id != "") { instanceBox.SelectedIndex = -1; instanceBox.Text = id; }
            SetStatus(String.IsNullOrWhiteSpace(tokenBox.Text) ? "当前已退出，请登录正确账号。" : "已载入本机加密配置。可直接启动，或重新登录。", true);
        } catch { SetStatus("旧配置无法读取，请重新登录；原文件已保留。", false); }
    }
    void Save() { Vault.Save(stateFile, tokenBox.Text.Trim(), InstanceId, (int)portBox.Value); }
    void ClearAccount() {
        StopProxy();
        Vault.Save(stateFile, "", "", (int)portBox.Value);
        tokenBox.Clear();
        instanceBox.Items.Clear(); instanceBox.Items.Add(new Instance("", "自动选择运行中的实例")); instanceBox.SelectedIndex = 0;
        account.Text = "当前已退出，请登录正确账号";
        SetStatus("旧凭证已清除，反代已停止。正在打开重新登录窗口…", true);
    }
    async Task LogoutAndLogin() {
        ClearAccount();
        await Login();
    }
    async Task Login() {
        var signedOut = String.IsNullOrWhiteSpace(tokenBox.Text);
        using (var dialog = new LoginWindow(Path.Combine(stateDir,"browser"), signedOut)) {
            Dictionary<string,object> result = null;
            dialog.ValidateToken = async candidate => { result = await Check(candidate); return Convert.ToBoolean(result["ok"]); };
            if (dialog.ShowDialog(this) != DialogResult.OK) { SetStatus(signedOut ? "已取消登录，当前保持退出状态。点击登录可重新选择账号。" : "已取消登录，原凭证未更改。", true); return; }
            // Validate the candidate first. Invalid candidates never overwrite a working token.
            SetStatus("正在校验登录凭证…", true);
            if (result == null) result = await Check(dialog.CapturedToken);
            if (!Convert.ToBoolean(result["ok"])) { SetStatus(Json.Text(result,"message"), false); return; }
            tokenBox.Text = dialog.CapturedToken; UpdateInstances(result); Save();
            account.Text = Json.Text(result,"accountHint", "当前登录账号") + " · " + Json.Text(result,"instanceCount", "0") + " 个实例";
            var ready = result.ContainsKey("ready") && Convert.ToBoolean(result["ready"]);
            SetStatus(ready ? "登录完成，凭证已加密保存。现在可以启动反代或导入 CC Switch。" : Json.Text(result,"message"), ready);
        }
    }
    async Task<Dictionary<string,object>> Check(string token) {
        var output = await RunNode("desktop-worker.mjs", "", Json.Encode(new { token = token }), 45000);
        return Json.Decode(output.Item2);
    }
    async Task<bool> ValidateSession() {
        if (String.IsNullOrWhiteSpace(tokenBox.Text)) { SetStatus("请先点击登录按钮。", false); return false; }
        SetStatus("正在校验登录并读取实例…", true);
        var result = await Check(tokenBox.Text.Trim());
        if (!Convert.ToBoolean(result["ok"])) { account.Text = "登录校验未通过"; SetStatus(Json.Text(result,"message"),false); return false; }
        UpdateInstances(result); Save();
        account.Text = Json.Text(result,"accountHint", "当前登录账号") + " · " + Json.Text(result,"instanceCount", "0") + " 个实例";
        var ready = result.ContainsKey("ready") && Convert.ToBoolean(result["ready"]);
        SetStatus(Json.Text(result,"message", "登录有效，实例已刷新。"), ready);
        if (!ready) return false;
        // A manually selected stopped/missing instance must not look ready merely
        // because another instance on the same account is running.
        if (InstanceId != "") {
            var chosen = InstanceId;
            var rows = (System.Collections.IEnumerable)result["instances"];
            bool found = false;
            foreach (Dictionary<string,object> row in rows) if (Json.Text(row,"id") == chosen) {
                var state = Json.Text(row,"status").ToLowerInvariant();
                found = state == "running" || state == "active" || state == "ready"; break;
            }
            if (!found) { SetStatus("所选实例不存在或尚未运行，请更换实例或在官网启动后刷新。", false); return false; }
        }
        return true;
    }
    void UpdateInstances(Dictionary<string,object> result) {
        var selected = InstanceId;
        instanceBox.Items.Clear(); instanceBox.Items.Add(new Instance("", "自动选择运行中的实例"));
        object values;
        if (result.TryGetValue("instances",out values)) foreach (Dictionary<string,object> row in (System.Collections.IEnumerable)values) {
            var id = Json.Text(row,"id"); var item = new Instance(id, Json.Text(row,"name",id) + " · " + Json.Text(row,"status")); instanceBox.Items.Add(item);
        }
        instanceBox.SelectedIndex = 0;
        foreach (Instance item in instanceBox.Items) if (item.Id == selected) { instanceBox.SelectedItem = item; break; }
        if (selected != "" && instanceBox.SelectedIndex == 0) { instanceBox.SelectedIndex = -1; instanceBox.Text = selected; }
    }
    bool ProxyAlive() { try { return proxy != null && !proxy.HasExited; } catch { return false; } }
    void StopProxy() { if (ProxyAlive()) { proxy.Kill(); proxy.WaitForExit(3000); } if (proxy != null) proxy.Dispose(); proxy = null; runningKey = ""; }
    async Task<bool> StartProxy() {
        if (!await ValidateSession()) return false;
        var key = tokenBox.Text.Trim() + "\n" + InstanceId + "\n" + portBox.Value;
        if (ProxyAlive() && key == runningKey) { SetStatus("反代已运行 · auto · 127.0.0.1:" + portBox.Value, true); return true; }
        StopProxy();
        try { var listener = new TcpListener(IPAddress.Loopback, (int)portBox.Value); listener.Start(); listener.Stop(); }
        catch (SocketException) { SetStatus("端口已被其他程序占用。请更换端口，或先停止旧反代。", false); return false; }
        bridgeId = Guid.NewGuid().ToString("N");
        var info = NodeInfo("server.mjs", "");
        info.EnvironmentVariables["LV_SESSION_TOKEN"] = tokenBox.Text.Trim();
        info.EnvironmentVariables["LV_INSTANCE_ID"] = InstanceId;
        info.EnvironmentVariables["LV_MODEL_ID"] = "auto";
        info.EnvironmentVariables["LV_BRIDGE_ID"] = bridgeId;
        info.EnvironmentVariables["PORT"] = portBox.Value.ToString();
        proxy = Process.Start(info); proxy.StandardInput.Close(); proxy.BeginOutputReadLine(); proxy.BeginErrorReadLine();
        using (var client = new HttpClient(new HttpClientHandler { UseProxy = false })) {
            client.Timeout = TimeSpan.FromSeconds(1);
            for (int i=0;i<35;i++) {
                await Task.Delay(150);
                if (!ProxyAlive()) break;
                try {
                    var data = Json.Decode(await client.GetStringAsync("http://127.0.0.1:" + portBox.Value + "/bridge/status"));
                    if (Json.Text(data,"bridgeId") == bridgeId && ProxyAlive()) { runningKey = key; SetStatus("反代已运行 · auto · 127.0.0.1:" + portBox.Value, true); return true; }
                } catch { }
            }
        }
        StopProxy(); SetStatus("反代未能启动，请检查端口或 Node.js。", false); return false;
    }
    async Task Import() {
        var db = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cc-switch", "cc-switch.db");
        if (!File.Exists(db)) { SetStatus("找不到 CC Switch 数据库。请先安装并运行一次 CC Switch。", false); return; }
        if (Process.GetProcessesByName("cc-switch").Length > 0) { SetStatus("请先完全退出 CC Switch（包括托盘），再点击导入。", false); return; }
        if (!await StartProxy()) return;
        var result = await RunNode("ccswitch-import.mjs", Quote(db), null, 30000, new Dictionary<string,string> {
            {"LV_PROXY_URL", "http://127.0.0.1:" + portBox.Value + "/v1"}, {"LV_MODEL_ID", "auto"}
        });
        if (result.Item1 != 0) { SetStatus("导入失败，未切换供应商。请确认 CC Switch 已退出，数据库未被占用。", false); return; }
        var data = Json.Decode(result.Item2);
        if (!data.ContainsKey("ok") || !Convert.ToBoolean(data["ok"])) throw new InvalidOperationException();
        SetStatus("已备份并导入 CC Switch，LightVela 已设为当前 Codex 供应商。请打开 CC Switch。", true);
    }
    void OpenCCSwitch() {
        var roots = new[] { Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) };
        var candidates = roots.SelectMany(r => new[] { Path.Combine(r,"Programs","CC Switch","cc-switch.exe"), Path.Combine(r,"CC Switch","cc-switch.exe"), Path.Combine(r,"Programs","cc-switch","cc-switch.exe") });
        var exe = candidates.FirstOrDefault(File.Exists);
        if (exe == null) { SetStatus("未找到 CC Switch 程序，请从原快捷方式打开。", false); return; }
        Process.Start(exe);
    }
    static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    ProcessStartInfo NodeInfo(string script, string args) {
        var info = new ProcessStartInfo(node, Quote(Path.Combine(root,script)) + " " + args) {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        // Only the proxy receives the current credential; unrelated child tools do not.
        info.EnvironmentVariables.Remove("LV_SESSION_TOKEN");
        info.EnvironmentVariables.Remove("LV_API_BASE"); info.EnvironmentVariables.Remove("LV_WEB_ORIGIN");
        return info;
    }
    async Task<Tuple<int,string>> RunNode(string script, string args, string input, int timeout, Dictionary<string,string> env = null) {
        var info = NodeInfo(script,args); if (env != null) foreach (var entry in env) info.EnvironmentVariables[entry.Key] = entry.Value;
        using (var p = Process.Start(info)) {
            var stdout = p.StandardOutput.ReadToEndAsync(); var stderr = p.StandardError.ReadToEndAsync();
            if (input != null) await p.StandardInput.WriteAsync(input); p.StandardInput.Close();
            var wait = Task.Run(() => p.WaitForExit());
            if (await Task.WhenAny(wait, Task.Delay(timeout)) != wait) { try { p.Kill(); } catch { } throw new TimeoutException(); }
            await wait; var text = await stdout; await stderr;
            return Tuple.Create(p.ExitCode,text);
        }
    }
    class Instance { public readonly string Id; readonly string label; public Instance(string id,string text) { Id=id; label=text; } public override string ToString() { return label; } }
}
}
