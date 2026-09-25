"""Generates the synthetic test fixtures described in MVP_BUILD_PLAN.md section 10."""
import numpy as np
import pandas as pd
import joblib
from sklearn.linear_model import LogisticRegression

rng = np.random.default_rng(42)

# --- 1. CSV for direct scoring (good version -> should land "low" risk) ---
n = 200
predicted = rng.integers(0, 2, n)
actual = predicted.copy()
flip_idx = rng.choice(n, size=int(n * 0.05), replace=False)  # 5% wrong -> ~95% accuracy
actual[flip_idx] = 1 - actual[flip_idx]
protected = rng.integers(0, 2, n)
pd.DataFrame({"predicted": predicted, "actual": actual, "protected_attribute": protected}).to_csv(
    "good_predictions.csv", index=False
)

# --- 2. CSV for direct scoring (bad version -> should land "high" risk) ---
predicted2 = rng.integers(0, 2, n)
actual2 = rng.integers(0, 2, n)  # essentially random vs predicted -> ~50% accuracy
protected2 = rng.integers(0, 2, n)
pd.DataFrame({"predicted": predicted2, "actual": actual2, "protected_attribute": protected2}).to_csv(
    "bad_predictions.csv", index=False
)

# --- 3. Dummy fitted sklearn model (joblib) ---
X = rng.random((200, 4))
y = (X[:, 0] + X[:, 1] > 1).astype(int)
model = LogisticRegression().fit(X, y)
joblib.dump(model, "dummy_model.joblib")

# --- 4. Companion dataset CSV matching the model's 4 features ---
X_test = rng.random((100, 4))
y_test = (X_test[:, 0] + X_test[:, 1] > 1).astype(int)
protected3 = rng.integers(0, 2, 100)
df = pd.DataFrame(X_test, columns=["f1", "f2", "f3", "f4"])
df["actual"] = y_test
df["protected_attribute"] = protected3
df.to_csv("model_dataset.csv", index=False)

# --- 5. A deliberately MISMATCHED dataset (3 features instead of 4) to test the error path ---
X_bad = rng.random((50, 3))
df_bad = pd.DataFrame(X_bad, columns=["f1", "f2", "f3"])
df_bad["actual"] = rng.integers(0, 2, 50)
df_bad["protected_attribute"] = rng.integers(0, 2, 50)
df_bad.to_csv("mismatched_dataset.csv", index=False)

print("Generated: good_predictions.csv, bad_predictions.csv, dummy_model.joblib, model_dataset.csv, mismatched_dataset.csv")
