import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from "react";
import api, { extractError, setOrgHeader } from "../api/axios.js";

const AuthContext = createContext(null);

const FLASH_KEY = "modelward_flash";
const ORG_KEY = "modelward.activeOrg";
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

function setFlash(msg) {
  try {
    sessionStorage.setItem(FLASH_KEY, msg);
  } catch {
    /* storage blocked: no notice, still logged out */
  }
}

// Only a well-formed { id: 24 hex chars, name } is ever trusted; anything else is dropped.
function sanitizeOrg(org) {
  if (!org || typeof org !== "object") return null;
  if (typeof org.id !== "string" || !OBJECT_ID_RE.test(org.id)) return null;
  const name = typeof org.name === "string" ? org.name.slice(0, 200) : "";
  return { id: org.id, name };
}

function readStoredOrg() {
  try {
    const raw = sessionStorage.getItem(ORG_KEY);
    return raw ? sanitizeOrg(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeStoredOrg(org) {
  try {
    if (org) sessionStorage.setItem(ORG_KEY, JSON.stringify(org));
    else sessionStorage.removeItem(ORG_KEY);
  } catch {
    /* storage blocked: the selection just lasts until the next reload */
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem("modelward_token"));
  const [loading, setLoading] = useState(true);
  const [activeOrg, setActiveOrgState] = useState(readStoredOrg);
  const alive = useRef(true);
  const isSuperRef = useRef(false);

  // Drops the selection everywhere (state, sessionStorage, the axios header).
  const clearActiveOrg = useCallback(() => {
    writeStoredOrg(null);
    setOrgHeader(null);
    setActiveOrgState(null);
  }, []);

  // Super admin only. The header is updated synchronously too, so a request fired right after
  // switching organization already carries the new one.
  const setActiveOrg = useCallback(
    (org) => {
      const clean = isSuperRef.current ? sanitizeOrg(org) : null;
      writeStoredOrg(clean);
      setOrgHeader(clean ? clean.id : null);
      setActiveOrgState(clean);
    },
    []
  );

  // Runs before any child effect, so pages never fetch with a stale / foreign org header.
  useLayoutEffect(() => {
    const isSuper = user?.role === "super_admin";
    isSuperRef.current = isSuper;
    setOrgHeader(isSuper && activeOrg ? activeOrg.id : null);
    // A signed-in non-super user can never carry a selection (user === null is the boot-time
    // check, where a super admin's stored selection must survive until /auth/me answers).
    if (user && !isSuper && activeOrg) clearActiveOrg();
  }, [user, activeOrg, clearActiveOrg]);

  const logout = useCallback(() => {
    localStorage.removeItem("modelward_token");
    isSuperRef.current = false;
    clearActiveOrg();
    setToken(null);
    setUser(null);
  }, [clearActiveOrg]);

  const loadMe = useCallback(async () => {
    const storedToken = localStorage.getItem("modelward_token");
    if (!storedToken) {
      clearActiveOrg();
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
        clearActiveOrg();
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
  }, [clearActiveOrg]);

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

  // A 400 ORG_REQUIRED means the selected organization is missing or unknown: forget it, but
  // keep the user signed in (they just have to pick an organization again).
  useEffect(() => {
    window.addEventListener("modelward:org-required", clearActiveOrg);
    return () => window.removeEventListener("modelward:org-required", clearActiveOrg);
  }, [clearActiveOrg]);

  // Also used with the { token, user } that /auth/setup-password returns.
  const login = useCallback(
    (newToken, newUser) => {
      localStorage.setItem("modelward_token", newToken);
      try {
        sessionStorage.removeItem(FLASH_KEY);
      } catch {
        /* ignore */
      }
      // A new sign-in always starts without an organization selected.
      isSuperRef.current = newUser?.role === "super_admin";
      clearActiveOrg();
      setToken(newToken);
      setUser(newUser);
    },
    [clearActiveOrg]
  );

  const value = useMemo(
    () => ({ user, token, loading, login, logout, activeOrg, setActiveOrg }),
    [user, token, loading, login, logout, activeOrg, setActiveOrg]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
