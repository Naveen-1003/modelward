import React, { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from "react";
import api, { extractError } from "../api/axios.js";

const AuthContext = createContext(null);

const FLASH_KEY = "modelward_flash";

function setFlash(msg) {
  try {
    sessionStorage.setItem(FLASH_KEY, msg);
  } catch {
    /* storage blocked: no notice, still logged out */
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem("modelward_token"));
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const logout = useCallback(() => {
    localStorage.removeItem("modelward_token");
    setToken(null);
    setUser(null);
  }, []);

  const loadMe = useCallback(async () => {
    const storedToken = localStorage.getItem("modelward_token");
    if (!storedToken) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const { data } = await api.get("/auth/me");
      if (alive.current) setUser(data.user);
    } catch (err) {
      if (!alive.current) return;
      if (err?.response?.status === 401) {
        // Rejected token. The axios interceptor already cleared it and set the
        // "session expired" flash; don't add a second message here.
        localStorage.removeItem("modelward_token");
        setToken(null);
      } else {
        // 403 / 429 / 5xx / network: the token may still be good, so keep it (a reload
        // can recover) but be honest on the login screen about why we're showing it.
        setFlash(extractError(err));
      }
      setUser(null);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    loadMe();
    return () => {
      alive.current = false;
    };
  }, [loadMe]);

  // The axios 401 interceptor can't reach React state, so it signals via a window event.
  useEffect(() => {
    window.addEventListener("modelward:unauthorized", logout);
    return () => window.removeEventListener("modelward:unauthorized", logout);
  }, [logout]);

  const login = useCallback((newToken, newUser) => {
    localStorage.setItem("modelward_token", newToken);
    try {
      sessionStorage.removeItem(FLASH_KEY);
    } catch {
      /* ignore */
    }
    setToken(newToken);
    setUser(newUser);
  }, []);

  const value = useMemo(
    () => ({ user, token, loading, login, logout }),
    [user, token, loading, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
