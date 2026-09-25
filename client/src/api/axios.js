import axios from "axios";

const api = axios.create({ baseURL: "/api" });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("modelward_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Centralize "what went wrong" extraction so every page doesn't reinvent it.
export function extractError(err) {
  return err?.response?.data?.error || err?.message || "Something went wrong";
}

export default api;
