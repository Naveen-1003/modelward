import React from "react";

export default class ErrorBoundary extends React.Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    console.error("Unhandled UI error:", error, info?.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="auth-main" role="alert" style={{ minHeight: "100vh" }}>
        <div className="panel" style={{ maxWidth: 440 }}>
          <h1 style={{ fontSize: "1.5rem" }}>Something went wrong</h1>
          <p className="muted" style={{ margin: "0.5rem 0 1.25rem" }}>
            The page hit an unexpected problem. Your data is safe — reloading usually fixes it.
          </p>
          <button type="button" onClick={() => window.location.reload()}>Reload page</button>
        </div>
      </main>
    );
  }
}
