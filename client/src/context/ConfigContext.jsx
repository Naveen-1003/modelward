import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import api from "../api/axios.js";

export const DEFAULT_CONFIG = {
  allowModelFiles: true,
  maxUploadMb: 25,
  enableDriftSimulation: true,
  storageMode: "local",
  minPasswordLength: 8,
  signupEnabled: true,
};

const ConfigContext = createContext({ config: DEFAULT_CONFIG, loading: false });

// Fetched once; rendering never waits on it, so a slow or failing /config just
// leaves the safe defaults in place.
export function ConfigProvider({ children }) {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .get("/config")
      .then(({ data }) => {
        if (!cancelled && data && typeof data === "object") setConfig({ ...DEFAULT_CONFIG, ...data });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(() => ({ config, loading }), [config, loading]);
  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function useConfig() {
  return useContext(ConfigContext);
}
