import React, { useEffect, useState } from "react";
import api, { extractError, extractFields } from "../../api/axios.js";
import { useToast } from "../../context/ToastContext.jsx";
import { Loading, ErrorBox } from "../../components/ui.jsx";
import { formatDate } from "./format.js";

const FIELDS = [
  { key: "lowAccuracy", label: "Low risk: minimum accuracy", help: "A version needs at least this accuracy to be rated Low risk." },
  { key: "lowFairnessGap", label: "Low risk: maximum fairness gap", help: "The spread between the best and worst group's accuracy must be at most this for Low risk." },
  { key: "mediumAccuracy", label: "Medium risk: minimum accuracy", help: "Below the Low bar but at least this accuracy is Medium risk; anything lower is High." },
  { key: "mediumFairnessGap", label: "Medium risk: maximum fairness gap", help: "A fairness gap above this is High risk, however accurate the model is." },
  { key: "driftThreshold", label: "Drift threshold", help: "A monitoring snapshot is flagged when accuracy or the fairness gap moves more than this from the baseline." },
];
const KEYS = FIELDS.map((f) => f.key);

function toForm(settings) {
  const f = {};
  KEYS.forEach((k) => {
    f[k] = settings?.[k] != null ? String(settings[k]) : "";
  });
  return f;
}

// Mirrors the server: each value in (0, 1], low bar at least as strict as medium.
function validate(form) {
  const errors = {};
  const nums = {};
  KEYS.forEach((k) => {
    const raw = String(form[k]).trim();
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) errors[k] = "Enter a number between 0 and 1.";
    else if (n <= 0 || n > 1) errors[k] = "Must be greater than 0 and at most 1.";
    else nums[k] = n;
  });
  if (!errors.lowAccuracy && !errors.mediumAccuracy && nums.lowAccuracy < nums.mediumAccuracy) {
    errors.lowAccuracy = "Low-risk accuracy must be at least the medium-risk accuracy.";
  }
  if (!errors.lowFairnessGap && !errors.mediumFairnessGap && nums.lowFairnessGap > nums.mediumFairnessGap) {
    errors.lowFairnessGap = "Low-risk fairness gap must be no larger than the medium-risk gap.";
  }
  return { errors, nums };
}

export default function ThresholdsTab() {
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [loadError, setLoadError] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get("/settings")
      .then(({ data }) => {
        if (cancelled) return;
        setSettings(data.settings);
        setForm(toForm(data.settings));
      })
      .catch((err) => {
        if (!cancelled) setLoadError(extractError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) return <ErrorBox>{loadError}</ErrorBox>;
  if (!form) return <Loading />;

  const dirty = KEYS.some((k) => String(form[k]).trim() !== String(settings?.[k]));

  async function save(ev) {
    ev.preventDefault();
    setFormError("");
    const { errors: found, nums } = validate(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      const { data } = await api.put("/settings", nums);
      setSettings(data.settings);
      setForm(toForm(data.settings));
      toast.success("Thresholds saved. They apply to versions uploaded from now on.");
    } catch (err) {
      setErrors(extractFields(err));
      setFormError(extractError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>Risk and drift thresholds</h2>
          <p className="muted small">
            Applies to versions uploaded after saving. Existing versions keep the thresholds they were scored with.
          </p>
        </div>
        {settings?.updatedAt && (
          <span className="muted small">
            Last updated {formatDate(settings.updatedAt)}
            {settings.updatedByName ? ` by ${settings.updatedByName}` : ""}
          </span>
        )}
      </div>
      <ErrorBox>{formError}</ErrorBox>
      <form onSubmit={save} noValidate>
        <div className="form-grid">
          {FIELDS.map((f) => (
            <label key={f.key}>
              {f.label}
              <input
                type="text"
                inputMode="decimal"
                className="mono"
                value={form[f.key]}
                onChange={(e) => {
                  setForm({ ...form, [f.key]: e.target.value });
                  if (errors[f.key]) setErrors({ ...errors, [f.key]: undefined });
                }}
                aria-invalid={errors[f.key] ? true : undefined}
                aria-describedby={`th-${f.key}-help`}
              />
              <small className="hint" id={`th-${f.key}-help`}>{f.help}</small>
              {errors[f.key] && <small className="field-error" role="alert">{errors[f.key]}</small>}
            </label>
          ))}
        </div>
        <div className="btn-row">
          <button type="submit" disabled={saving || !dirty} aria-busy={saving}>{saving ? "Saving…" : "Save thresholds"}</button>
          <button type="button" className="secondary" disabled={saving || !dirty} onClick={() => { setForm(toForm(settings)); setErrors({}); setFormError(""); }}>
            Reset
          </button>
        </div>
      </form>
    </div>
  );
}
