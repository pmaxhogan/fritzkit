#Requires AutoHotkey v2.0
; Generic desktop driver for the Fritzing e2e exploration.
; Usage: AutoHotkey64.exe do.ahk <cmd> [args...]   (one command per invocation; chain with ";" separated commands)
;   launch <exe> [file]      start Fritzing (optionally with a file), wait for its window, maximize
;   activate                 bring Fritzing's main window to front and maximize
;   click x y                left click at screen coords
;   rclick x y               right click
;   dblclick x y
;   drag x1 y1 x2 y2 [steps] press at (x1,y1), move in steps to (x2,y2), release (slow, for Qt)
;   move x y
;   key keys                 Send keys (AHK syntax, e.g. ^n, ^s, {Esc})
;   type text                SendText
;   sleep ms
;   pixel x y                print the pixel colour at x y
;   win                      list Fritzing windows (hwnd|title|class|x,y,w,h)
;   wintitle                 print the active Fritzing window title
CoordMode("Mouse", "Screen")
CoordMode("Pixel", "Screen")
SetMouseDelay(20)
SetDefaultMouseSpeed(2)
SetTitleMatchMode(2)

out(s) {
    FileAppend(s "`n", "*")
}

runCmd(parts) {
    cmd := parts[1]
    switch cmd {
        case "launch":
            exe := parts[2]
            if parts.Length >= 3
                Run('"' exe '" "' parts[3] '"')
            else
                Run('"' exe '"')
            if !WinWait("Fritzing ahk_exe Fritzing.exe", , 60) {
                out("ERR no window")
                return
            }
            Sleep(5000)
            runCmd(["activate"])
        case "activate":
            ; pick the largest Fritzing window (the main window, not a dialog)
            best := 0, bestArea := 0
            for hwnd in WinGetList("ahk_exe Fritzing.exe") {
                WinGetPos(&x, &y, &w, &h, hwnd)
                if (w * h > bestArea) {
                    bestArea := w * h, best := hwnd
                }
            }
            if best {
                t := ""
                try {
                    t := WinGetTitle(best)
                    WinActivate(best)
                    WinMaximize(best)
                } catch as e {
                    out("WARN activate: " e.Message)
                }
                Sleep(800)
                out("activated " t)
            } else
                out("ERR no window")
        case "activatet":
            ; activate + maximize the Fritzing window whose title contains parts[2]
            found := 0
            for hwnd in WinGetList("ahk_exe Fritzing.exe") {
                if InStr(WinGetTitle(hwnd), parts[2]) {
                    found := hwnd
                    break
                }
            }
            if found {
                t := WinGetTitle(found)
                try {
                    WinActivate(found)
                    WinMaximize(found)
                } catch as e {
                    out("WARN activatet: " e.Message)
                }
                Sleep(800)
                out("activated " t)
            } else
                out("ERR no window with " parts[2])
        case "close":
            ; close the Fritzing window whose title contains parts[2] (WinClose = graceful)
            for hwnd in WinGetList("ahk_exe Fritzing.exe") {
                t := WinGetTitle(hwnd)
                if InStr(t, parts[2]) {
                    WinClose(hwnd)
                    out("closed " t)
                    break
                }
            }
        case "click":
            Click(parts[2], parts[3])
            out("clicked " parts[2] "," parts[3])
        case "rclick":
            Click(parts[2], parts[3], "Right")
        case "dblclick":
            Click(parts[2], parts[3], 2)
        case "move":
            MouseMove(parts[2], parts[3])
        case "drag":
            x1 := Integer(parts[2]), y1 := Integer(parts[3]), x2 := Integer(parts[4]), y2 := Integer(parts[5])
            steps := parts.Length >= 6 ? Integer(parts[6]) : 20
            MouseMove(x1, y1)
            Sleep(150)
            Click("Down")
            Sleep(250)
            loop steps {
                t := A_Index / steps
                MouseMove(Round(x1 + (x2 - x1) * t), Round(y1 + (y2 - y1) * t))
                Sleep(30)
            }
            Sleep(250)
            Click("Up")
            Sleep(200)
            out("dragged " x1 "," y1 " -> " x2 "," y2)
        case "key":
            Send(parts[2])
            Sleep(300)
            out("sent " parts[2])
        case "type":
            SendText(parts[2])
            Sleep(200)
        case "sleep":
            Sleep(Integer(parts[2]))
        case "pixel":
            out(Format("pixel {},{} = {}", parts[2], parts[3], PixelGetColor(parts[2], parts[3])))
        case "win":
            for hwnd in WinGetList("ahk_exe Fritzing.exe") {
                WinGetPos(&x, &y, &w, &h, hwnd)
                out(hwnd "|" WinGetTitle(hwnd) "|" WinGetClass(hwnd) "|" x "," y "," w "," h)
            }
        case "wintitle":
            out(WinGetTitle("A"))
        default:
            out("ERR unknown " cmd)
    }
}

args := A_Args
if args.Length = 0 {
    out("usage: do.ahk <cmd> ...")
    ExitApp(1)
}
; split on ";" tokens into separate commands
cur := []
for a in args {
    if (a = ";") {
        if cur.Length
            runCmd(cur)
        cur := []
    } else
        cur.Push(a)
}
if cur.Length
    runCmd(cur)
ExitApp(0)
