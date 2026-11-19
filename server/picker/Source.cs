using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

internal static class LinkWavePicker
{
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    private static string JsonString(string value)
    {
        var output = new StringBuilder("\"");
        foreach (char character in value)
        {
            switch (character)
            {
                case '\"': output.Append("\\\""); break;
                case '\\': output.Append("\\\\"); break;
                case '\b': output.Append("\\b"); break;
                case '\f': output.Append("\\f"); break;
                case '\n': output.Append("\\n"); break;
                case '\r': output.Append("\\r"); break;
                case '\t': output.Append("\\t"); break;
                default:
                    if (character < 0x20) output.Append("\\u" + ((int)character).ToString("x4"));
                    else output.Append(character);
                    break;
            }
        }
        return output.Append('"').ToString();
    }

    private static void WritePaths(string[] paths)
    {
        using (var writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)))
        {
            writer.Write("{\"paths\":[");
            for (int index = 0; index < paths.Length; index++)
            {
                if (index != 0) writer.Write(',');
                writer.Write(JsonString(paths[index]));
            }
            writer.Write("]}");
            writer.Flush();
        }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            // Build verification checks the GUI executable's redirected UTF-8 pipe.
            if (args.Length == 1 && args[0] == "--self-test")
            {
                WritePaths(new string[] { "C:\\中文 空格\\原文件.txt", "C:\\test\\quote\"and\\backslash.txt" });
                return 0;
            }
            if (args.Length != 0) return 2;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var owner = new Form())
            using (var dialog = new OpenFileDialog())
            {
                owner.Text = "邻波文件选择器";
                owner.TopMost = true;
                owner.ShowInTaskbar = false;
                owner.FormBorderStyle = FormBorderStyle.FixedToolWindow;
                owner.StartPosition = FormStartPosition.CenterScreen;
                owner.Width = 1;
                owner.Height = 1;
                owner.Opacity = 0;
                dialog.Title = "选择要直接发送的原文件";
                dialog.Filter = "所有文件 (*.*)|*.*";
                dialog.Multiselect = true;
                dialog.CheckFileExists = true;
                dialog.CheckPathExists = true;
                dialog.RestoreDirectory = true;
                dialog.AutoUpgradeEnabled = true;
                owner.Show();
                owner.Activate();
                SetForegroundWindow(owner.Handle);
                WritePaths(dialog.ShowDialog(owner) == DialogResult.OK ? dialog.FileNames : new string[0]);
            }
            return 0;
        }
        catch
        {
            using (var writer = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)))
            {
                writer.Write("无法打开本机文件选择窗口，请重试");
                writer.Flush();
            }
            return 1;
        }
    }
}
