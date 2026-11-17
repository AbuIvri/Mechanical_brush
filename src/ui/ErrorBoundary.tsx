import { Component, type ReactNode } from "react";
import { saveRecoveryNow } from "../state/store";

// The last line of defence for the interface. Without it, an exception while drawing any
// part of the screen unmounted the whole app: a blank window, the work in memory with no
// way back to it except quitting. Now the crash is caught, every document with unsaved
// work is written to its recovery slot at once, and the user is offered a reload — which
// brings up the usual "restore?" banner for those slots.

type SaveState = "saving" | "ok" | "fail" | "none";

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; saved: SaveState }> {
  state: { error: Error | null; saved: SaveState } = { error: null, saved: "none" };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // console.error reaches the main process's log file (see electron/log.ts).
    console.error(`[crash] ${error?.stack || error}\n${info?.componentStack ?? ""}`);
    void this.save();
  }

  save = async () => {
    this.setState({ saved: "saving" });
    try {
      await saveRecoveryNow();
      this.setState({ saved: "ok" });
    } catch {
      this.setState({ saved: "fail" });
    }
  };

  render() {
    const { error, saved } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <div className="modal crash-box">
          <div className="modal-title">משהו השתבש בתצוגה</div>
          <p className="onboard-lead">
            האפליקציה נתקלה בשגיאה ועצרה את המסך. עבודה שלא נשמרה נכתבת לעותק שחזור; אחרי
            טעינה מחדש האפליקציה תציע לשחזר אותה.
          </p>
          <p className="crash-saved">
            {saved === "saving" && "כותב עותק שחזור…"}
            {saved === "ok" && "עותק השחזור נשמר."}
            {saved === "fail" && "לא הצלחתי לכתוב עותק שחזור. אחרי הטעינה בדוק מה נשמר."}
          </p>
          <pre className="crash-detail" dir="ltr">{String(error?.message || error)}</pre>
          <div className="modal-actions">
            <button className="primary" disabled={saved === "saving"} onClick={() => location.reload()}>
              טען מחדש
            </button>
            <button onClick={() => this.setState({ error: null, saved: "none" })}>נסה להמשיך</button>
          </div>
        </div>
      </div>
    );
  }
}
