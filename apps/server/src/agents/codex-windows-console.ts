import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A private, hidden console supplies UTF-8 to sandboxed PowerShell too. Changing
// chcp in Tower's inherited console would also change the user's terminal.
// Preserve the RPC pipes explicitly, and own descendants with a kill-on-close job.
const source = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
class TowerConsole {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title;
    public int x,y,xSize,ySize,xCount,yCount,fill,flags;
    public short show, reservedSize; public IntPtr reserved2, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking;
    public uint active; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder args, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref StartupEx startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sp, IntPtr handle, IntPtr tp, out IntPtr copy, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCP(uint cp);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleOutputCP(uint cp);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  // CommandLineToArgvW/CRT quoting, without a cmd.exe or PowerShell parser.
  static string Quote(string arg) {
    var result = new StringBuilder("\""); int slashes=0;
    foreach (char c in arg) {
      if (c=='\\') { slashes++; continue; }
      if (c=='"') { result.Append('\\',slashes*2+1); result.Append(c); }
      else { result.Append('\\',slashes); result.Append(c); }
      slashes=0;
    }
    result.Append('\\',slashes*2); result.Append('"'); return result.ToString();
  }
  static IntPtr Pipe(int kind) {
    IntPtr copy; var self=GetCurrentProcess();
    Check(DuplicateHandle(self,GetStdHandle(kind),self,out copy,0,true,2)); return copy;
  }
  static int Run(string[] args, bool consoleChild) {
    if (consoleChild) { Check(SetConsoleCP(65001)); Check(SetConsoleOutputCP(65001)); }
    var command = new StringBuilder();
    if (!consoleChild) command.Append(Quote(Process.GetCurrentProcess().MainModule.FileName)).Append(" --tower-console-child");
    for (int i=consoleChild?1:0;i<args.Length;i++) { if(command.Length>0)command.Append(' '); command.Append(Quote(args[i])); }
    var startup = new StartupEx { startup=new Startup { cb=Marshal.SizeOf(typeof(StartupEx)), flags=0x101, show=0 } };
    IntPtr job=IntPtr.Zero, jobList=IntPtr.Zero; ProcessInfo child=new ProcessInfo(); bool created=false, attributesReady=false;
    try {
      startup.startup.input=Pipe(-10); startup.startup.output=Pipe(-11); startup.startup.error=Pipe(-12);
      if (!consoleChild) {
        job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
        var limit=new ExtendedLimit(); limit.basic.flags=0x2000;
        Check(SetInformationJobObject(job,9,ref limit,Marshal.SizeOf(typeof(ExtendedLimit))));
        IntPtr size=IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
        startup.attributes=Marshal.AllocHGlobal(size);
        Check(InitializeProcThreadAttributeList(startup.attributes,1,0,ref size)); attributesReady=true;
        jobList=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList,job);
        // PROC_THREAD_ATTRIBUTE_JOB_LIST assigns ownership during CreateProcess itself.
        // No suspended, unowned child can survive termination of the outer launcher.
        Check(UpdateProcThreadAttribute(startup.attributes,0,new IntPtr(0x2000d),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      }
      Check(CreateProcess(null,command,IntPtr.Zero,IntPtr.Zero,true,0x80000u|(consoleChild?0u:0x10u),IntPtr.Zero,null,ref startup,out child)); created=true;
      WaitForSingleObject(child.process,0xffffffff); uint exitCode;
      Check(GetExitCodeProcess(child.process,out exitCode)); return unchecked((int)exitCode);
    } catch { if(created)TerminateProcess(child.process,1); throw; }
    finally {
      if(attributesReady)DeleteProcThreadAttributeList(startup.attributes);
      if(startup.attributes!=IntPtr.Zero)Marshal.FreeHGlobal(startup.attributes);
      if(jobList!=IntPtr.Zero)Marshal.FreeHGlobal(jobList);
      if(job!=IntPtr.Zero)CloseHandle(job);
      if(created) { CloseHandle(child.thread); CloseHandle(child.process); }
      foreach(var pipe in new[]{startup.startup.input,startup.startup.output,startup.startup.error}) if(pipe!=IntPtr.Zero)CloseHandle(pipe);
    }
  }
  static int Main(string[] args) {
    try { if(args.Length==0)throw new ArgumentException("Missing command"); return Run(args,args[0]=="--tower-console-child"); }
    catch(Exception error) { Console.Error.WriteLine("Tower UTF-8 launcher: "+error.Message); return 1; }
  }
}
`;

let cached: { file: string; hash: string } | undefined;

function noLinks(file: string): void {
  let current = path.resolve(file);
  while (true) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('UTF-8 console runtime cannot use linked paths.');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Only the binary generated by this process is trusted; config/DLL sidecars are not. */
export function validateConsoleBinary(file: string, expectedHash: string): void {
  noLinks(file);
  const stat = fs.lstatSync(file);
  const entries = fs.readdirSync(path.dirname(file));
  if (!stat.isFile() || stat.nlink !== 1 || entries.length !== 1 || entries[0] !== path.basename(file)) {
    throw new Error('UTF-8 console runtime contains an unexpected file or link.');
  }
  if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expectedHash) {
    throw new Error('UTF-8 console runtime integrity check failed.');
  }
}

function privateDirectory(directory: string, windows: string): void {
  // The restricted sandbox cannot replace the launcher through the usual writable TEMP root.
  const identity = spawnSync(path.join(windows, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  const sid = identity.stdout?.match(/S-1-5-[\d-]+/)?.[0];
  if (identity.status !== 0 || !sid) throw new Error('Cannot determine the owner of the UTF-8 console runtime.');
  const secured = spawnSync(path.join(windows, 'System32', 'icacls.exe'), [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (secured.error || secured.status !== 0) throw new Error('Cannot protect the UTF-8 console runtime directory.');
}

/** Compiles with Windows' bundled .NET Framework compiler; no download required. */
export function windowsConsoleLauncher(): string {
  if (cached) { validateConsoleBinary(cached.file, cached.hash); return cached.file; }
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 20);
  const local = path.resolve(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'));
  const temp = path.resolve(os.tmpdir()).toLowerCase();
  if (local.toLowerCase() === temp || local.toLowerCase().startsWith(temp + path.sep)) throw new Error('UTF-8 console runtime must be outside the temporary directory.');
  noLinks(local);
  let root = local;
  for (const part of ['Tower', 'runtime', 'codex-console']) {
    root = path.join(root, part);
    try { fs.mkdirSync(root); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    noLinks(root);
  }
  const windows = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const compiler = ['Framework64', 'Framework'].map((architecture) => path.join(windows, 'Microsoft.NET', architecture, 'v4.0.30319', 'csc.exe')).find((file) => fs.existsSync(file));
  if (!compiler) throw new Error('Windows .NET Framework C# compiler is required for the private UTF-8 console.');
  // Never execute a persisted cache entry supplied by a previous process.
  const directory = path.join(root, `${digest}-${randomUUID()}`);
  fs.mkdirSync(directory);
  noLinks(directory);
  privateDirectory(directory, windows);
  const input = path.join(directory, 'console.cs');
  const output = path.join(directory, 'console.exe');
  try {
    fs.writeFileSync(input, source, { encoding: 'utf8', flag: 'wx' });
    const result = spawnSync(compiler, ['/nologo', '/target:exe', '/optimize+', `/out:${output}`, input], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error(`UTF-8 console launcher compilation failed: ${result.error?.message ?? result.stdout + result.stderr}`);
    fs.unlinkSync(input);
    const hash = createHash('sha256').update(fs.readFileSync(output)).digest('hex');
    validateConsoleBinary(output, hash);
    cached = { file: output, hash };
    return output;
  } finally {
    fs.rmSync(input, { force: true });
    if (!cached) fs.rmSync(output, { force: true });
  }
}
