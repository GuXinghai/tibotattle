// Windows x64 Native Messaging relay. No cookie parsing, file persistence or logs.
using System;
using System.IO;
using System.IO.Pipes;
using System.Diagnostics;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
class UsageMonitorXImport {
 const int Max = 524288;
 const string Origin = "chrome-extension://ididcmbpmekkeindgjimhcdffbnliejo/";
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe,out uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe,out uint pid);
 [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length;public IntPtr Descriptor;public bool Inherit; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafePipeHandle CreateNamedPipe(string name,uint openMode,uint mode,uint instances,uint outSize,uint inSize,uint timeout,ref SecurityAttributes attributes);
 static byte[] Exact(Stream stream,int length) {
  byte[] bytes=new byte[length];int at=0;
  try { while(at<length){int count=stream.Read(bytes,at,length-at);if(count<=0)throw new IOException();at+=count;}return bytes; }
  catch {Array.Clear(bytes,0,bytes.Length);throw;}
 }
 static byte[] Read(Stream stream) {byte[] header=Exact(stream,4);int count=BitConverter.ToInt32(header,0);if(count<2||count>Max)throw new IOException();return Exact(stream,count);}
 static byte[] TimedRead(Stream stream,int timeout=30000) {Task<byte[]> task=Task.Factory.StartNew(()=>Read(stream));if(!task.Wait(timeout))throw new IOException();return task.Result;}
 static void Write(Stream stream,byte[] bytes) {if(bytes.Length>Max)throw new IOException();byte[] header=BitConverter.GetBytes(bytes.Length);stream.Write(header,0,4);stream.Write(bytes,0,bytes.Length);stream.Flush();}
 static void Fixed(Stream stream,string code) {Write(stream,Encoding.UTF8.GetBytes("{\"ok\":false,\"code\":\""+code+"\"}"));}
 static string PublicPipe() {
  using(SHA256 sha=SHA256.Create()) {
   byte[] hash=sha.ComputeHash(Encoding.UTF8.GetBytes(WindowsIdentity.GetCurrent().User.Value));
   return "UsageMonitor.XImport."+BitConverter.ToString(hash,0,16).Replace("-","").ToLowerInvariant();
  }
 }
 static PipeSecurity Security() {
  PipeSecurity security=new PipeSecurity();security.SetAccessRuleProtection(true,false);
  security.SetOwner(WindowsIdentity.GetCurrent().User);
  security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,PipeAccessRights.FullControl,AccessControlType.Allow));
  security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),PipeAccessRights.FullControl,AccessControlType.Allow));
  return security;
 }
 static NamedPipeServerStream Server(string name) {
  byte[] descriptor=Security().GetSecurityDescriptorBinaryForm();
  GCHandle pinned=GCHandle.Alloc(descriptor,GCHandleType.Pinned);
  try {
   SecurityAttributes attributes=new SecurityAttributes();attributes.Length=Marshal.SizeOf(typeof(SecurityAttributes));attributes.Descriptor=pinned.AddrOfPinnedObject();attributes.Inherit=false;
   // First instance prevents accepting a squatted pipe; reject remote SMB clients.
   SafePipeHandle handle=CreateNamedPipe("\\\\.\\pipe\\"+name,0x40080003,8,1,4096,4096,0,ref attributes);
   if(handle.IsInvalid){handle.Dispose();throw new IOException();}
   return new NamedPipeServerStream(PipeDirection.InOut,true,false,handle);
  } finally {pinned.Free();Array.Clear(descriptor,0,descriptor.Length);}
 }
 static bool SameExecutable(uint pid) {
  try {using(Process peer=Process.GetProcessById((int)pid))return String.Equals(Path.GetFullPath(peer.MainModule.FileName),Path.GetFullPath(Process.GetCurrentProcess().MainModule.FileName),StringComparison.OrdinalIgnoreCase);}catch{return false;}
 }
 static int Broker(string[] args) {
  int ownerPid;
  if(args.Length!=3||!Int32.TryParse(args[2],out ownerPid)||!System.Text.RegularExpressions.Regex.IsMatch(args[1],"^UsageMonitor\\.XControl\\.[a-f0-9]{32}$"))return 2;
  using(Process owner=Process.GetProcessById(ownerPid))
  using(Timer watch=new Timer(_=>{try{if(owner.HasExited)Environment.Exit(0);}catch{Environment.Exit(0);}},null,1000,1000))
  using(NamedPipeServerStream control=Server(args[1])) {
   if(!control.WaitForConnectionAsync().Wait(10000))return 3;
   uint pid;if(!GetNamedPipeClientProcessId(control.SafePipeHandle,out pid)||pid!=(uint)ownerPid)return 2;
   // The parent established the private pipe before any browser connection.
   Write(control,Encoding.UTF8.GetBytes("{\"version\":1,\"type\":\"broker-ready\"}"));
   while(true) {
    using(NamedPipeServerStream client=Server(PublicPipe())) {
     client.WaitForConnection();
     if(!GetNamedPipeClientProcessId(client.SafePipeHandle,out pid)||!SameExecutable(pid))continue;
     byte[] request=null,response=null;
     try {request=TimedRead(client);Write(control,request);Array.Clear(request,0,request.Length);response=TimedRead(control,115000);Write(client,response);}
     catch {try{Fixed(client,"bridge_failed");}catch{};return 1;}
     finally {if(request!=null)Array.Clear(request,0,request.Length);if(response!=null)Array.Clear(response,0,response.Length);}
    }
   }
  }
 }
 static int Main(string[] args) {
  byte[] request=null,response=null;
  try {
   if(args.Length>0&&args[0]=="--broker")return Broker(args);
   if(args.Length<1||args[0].TrimEnd('/')!=Origin.TrimEnd('/'))return 2;
   request=Read(Console.OpenStandardInput());
   using(NamedPipeClientStream pipe=new NamedPipeClientStream(".",PublicPipe(),PipeDirection.InOut,PipeOptions.Asynchronous)) {
    try {pipe.Connect(3000);}catch {Fixed(Console.OpenStandardOutput(),"app_not_running");return 1;}
    uint pid;if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle,out pid)||!SameExecutable(pid))return 2;
    Write(pipe,request);Array.Clear(request,0,request.Length);response=TimedRead(pipe,115000);Write(Console.OpenStandardOutput(),response);
   }
   return 0;
  } catch {try{Fixed(Console.OpenStandardOutput(),"bridge_failed");}catch{};return 1;}
  finally {if(request!=null)Array.Clear(request,0,request.Length);if(response!=null)Array.Clear(response,0,response.Length);}
 }
}
