#!/bin/bash
# Double-click launcher for the dev build of "The Mechanical Brush".
# Lives in the project; a copy/alias on the Desktop makes it always reachable.
cd "/Users/nimrodsaunders/Documents/המכחול המכני - אפליקציה/the-mechanical-brush" || exit 1

echo "── המכחול המכני · גרסת פיתוח ──"

# Stop any previous instance so we don't hit the single-instance lock.
pkill -f "node_modules/.bin/vite" 2>/dev/null
pkill -f "Electron.app/Contents/MacOS/Electron" 2>/dev/null
rm -f "$HOME/Library/Application Support/The Mechanical Brush/Singleton"* 2>/dev/null
sleep 1

echo "מפעיל… (אל תסגרו את החלון הזה — הוא מריץ את האפליקציה)"
npm run dev
