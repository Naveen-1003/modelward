import React, { useState } from "react";
import { Icon } from "./ui.jsx";

// A password box with a show/hide button. Takes the same props as <input>.
export default function PasswordInput(props) {
  const [shown, setShown] = useState(false);
  const label = shown ? "Hide password" : "Show password";
  return (
    <span className="pw-field">
      <input {...props} type={shown ? "text" : "password"} />
      <button
        type="button"
        className="pw-toggle"
        onClick={() => setShown((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        aria-label={label}
        aria-pressed={shown}
        title={label}
      >
        <Icon name={shown ? "eyeOff" : "eye"} size={18} />
      </button>
    </span>
  );
}
