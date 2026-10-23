' Production Windows deployment only. Uses the bundled Node runtime, not npm.
' The deployment root is the parent of this scripts directory.
Option Explicit

Dim shell, fso, root, node, config, controller, code, problem
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
node = root & "\runtime\node.exe"
config = root & "\app\.env.server"
controller = root & "\scripts\deploy-background.mjs"

If Not fso.FileExists(node) Or Not fso.FileExists(config) Or Not fso.FileExists(controller) Then
  MsgBox "Extract this update into the existing Windows deployment folder first.", vbCritical, "WRJ"
  WScript.Quit 1
End If

shell.CurrentDirectory = root
On Error Resume Next
code = shell.Run(Quote(node) & " --env-file=" & Quote(config) & " " & Quote(controller) & " start --open-browser", 0, True)
problem = Err.Description
If Err.Number <> 0 Then
  On Error GoTo 0
  MsgBox "Unable to start WRJ: " & problem, vbCritical, "WRJ"
  WScript.Quit 1
End If
On Error GoTo 0

If code <> 0 Then
  MsgBox "WRJ did not start. See " & root & "\logs\background.log", vbCritical, "WRJ"
End If
WScript.Quit code

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
