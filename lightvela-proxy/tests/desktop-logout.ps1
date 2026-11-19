$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$vendor = Join-Path $root 'vendor\webview2'
$env:PATH = $vendor + ';' + $env:PATH
$refs = @('System.dll','System.Core.dll','System.Windows.Forms.dll','System.Drawing.dll','System.Web.Extensions.dll','System.Security.dll','System.Net.Http.dll',(Join-Path $vendor 'Microsoft.Web.WebView2.Core.dll'),(Join-Path $vendor 'Microsoft.Web.WebView2.WinForms.dll'))
[void][Reflection.Assembly]::LoadFrom((Join-Path $vendor 'Microsoft.Web.WebView2.Core.dll'))
[void][Reflection.Assembly]::LoadFrom((Join-Path $vendor 'Microsoft.Web.WebView2.WinForms.dll'))
$fixture = @'
namespace LightVelaBridge {
public static class LogoutTest {
    static void Assert(bool ok, string message) { if (!ok) throw new System.Exception(message); }
    static object Field(object o, string name) { return o.GetType().GetField(name, System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic).GetValue(o); }
    public static void Run(string root, string state) {
        System.Windows.Forms.Application.EnableVisualStyles();
        System.IO.Directory.CreateDirectory(state);
        var file = System.IO.Path.Combine(state,"settings.json");
        Vault.Save(file,"synthetic-old-token","synthetic-old-instance",8791);
        using (var window = new MainWindow(root,"node.exe",state)) {
            var token = (System.Windows.Forms.TextBox)Field(window,"tokenBox");
            var port = (System.Windows.Forms.NumericUpDown)Field(window,"portBox");
            Assert(token.Text == "synthetic-old-token", "Fixture failed to load");
            window.GetType().GetMethod("ClearAccount",System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic).Invoke(window,null);
            var saved = Json.Decode(System.IO.File.ReadAllText(file));
            Assert(token.Text == "" && Json.Text(saved,"token") == "", "Old token survived logout");
            Assert(Json.Text(saved,"instanceId") == "", "Old instance survived logout");
            Assert(port.Value == 8791 && Json.Text(saved,"port") == "8791", "Port was changed");
            Assert(((System.Windows.Forms.ComboBox)Field(window,"instanceBox")).SelectedIndex == 0,"Instance selection was not reset");
            window.Show(); System.Windows.Forms.Application.DoEvents();
            using (var bmp = new System.Drawing.Bitmap(window.Width,window.Height)) {
                window.DrawToBitmap(bmp,new System.Drawing.Rectangle(0,0,window.Width,window.Height));
                bmp.Save(System.IO.Path.Combine(state,"logout-ui.png"),System.Drawing.Imaging.ImageFormat.Png);
            }
            window.Close();
        }
        using (var reopened = new MainWindow(root,"node.exe",state)) {
            Assert(((System.Windows.Forms.TextBox)Field(reopened,"tokenBox")).Text == "", "Restart restored the old account");
        }
        System.Console.WriteLine("PASS: logout clears saved token/instance and preserves port across restart");
        var reserve = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback,0);
        reserve.Start(); int number = ((System.Net.IPEndPoint)reserve.LocalEndpoint).Port; reserve.Stop();
        var baseUrl = "http://127.0.0.1:" + number;
        using (var server = new System.Net.HttpListener()) {
            server.Prefixes.Add(baseUrl + "/"); server.Start();
            var serving = System.Threading.Tasks.Task.Run(async () => {
                try { while (server.IsListening) {
                    var context = await server.GetContextAsync();
                    var script = context.Request.Url.AbsolutePath == "/seed" ?
                        "localStorage.setItem('vela.lightvela.session-token.v1','synthetic-old-token');localStorage.setItem('lightclaw-auth-token-v1','synthetic-legacy-token');document.cookie='synthetic_auth=old; path=/';" :
                        "const stale=localStorage.getItem('vela.lightvela.session-token.v1')||localStorage.getItem('lightclaw-auth-token-v1')||document.cookie;localStorage.setItem('vela.lightvela.session-token.v1',stale?'stale-profile-detected':'synthetic-new-token');";
                    var bytes = System.Text.Encoding.UTF8.GetBytes("<!doctype html><title>Local logout fixture</title><script>" + script + "</script>");
                    context.Response.ContentType="text/html"; context.Response.ContentLength64=bytes.Length;
                    await context.Response.OutputStream.WriteAsync(bytes,0,bytes.Length); context.Response.Close();
                }} catch (System.Net.HttpListenerException) {} catch (System.ObjectDisposedException) {}
            });
            var profile = System.IO.Path.Combine(state,"browser");
            Assert(Capture(profile,new System.Uri(baseUrl + "/seed"),false) == "synthetic-old-token","Failed to seed old browser login");
            Assert(Capture(profile,new System.Uri(baseUrl + "/verify"),true) == "synthetic-new-token","Fresh login reused old localStorage or cookies");
            server.Stop(); serving.Wait(3000);
        }
        System.Console.WriteLine("PASS: fresh login clears both token keys and cookies before navigation/capture");
        System.Console.WriteLine("UI screenshot: " + System.IO.Path.Combine(state,"logout-ui.png"));
    }
    static string Capture(string profile, System.Uri site, bool fresh) {
        using (var dialog = new LoginWindow(profile,site,fresh))
        using (var watchdog = new System.Windows.Forms.Timer()) {
            watchdog.Interval=20000; watchdog.Tick += (s,e) => { watchdog.Stop(); dialog.Close(); };
            watchdog.Start(); var result = dialog.ShowDialog(); watchdog.Stop();
            Assert(result == System.Windows.Forms.DialogResult.OK,"Browser fixture did not finish");
            return dialog.CapturedToken;
        }
    }
}
}
'@
$source = [IO.File]::ReadAllText((Join-Path $root 'DesktopBridge.cs')) + [Environment]::NewLine + $fixture
Add-Type -TypeDefinition $source -ReferencedAssemblies $refs
$state = Join-Path ([IO.Path]::GetTempPath()) ('lightvela-logout-test-' + [Guid]::NewGuid().ToString('N'))
[LightVelaBridge.LogoutTest]::Run($root,$state)
