"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { User } from "@/lib/types";
import { api, AUTH_LOGOUT_EVENT } from "@/lib/client/api";
import {
  clearTokens,
  getStoredUser,
  hydrateTokens,
  setStoredUser,
  setTokens,
} from "@/lib/client/token-store";

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

interface AuthContextValue {
  user: User | null;
  /** Hydration finished — safe to make auth decisions (avoids first-paint flicker). */
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    hydrateTokens();
    setUser(getStoredUser<User>());
    setReady(true);
  }, []);

  const logout = useCallback(() => {
    clearTokens();
    setUser(null);
    // Drop cached jobs/runs too — otherwise the next sign-in briefly renders the previous
    // session's data before the refetch lands.
    queryClient.clear();
    router.replace("/signin");
  }, [queryClient, router]);

  // If apiFetch can't recover auth it dispatches AUTH_LOGOUT_EVENT — react globally.
  useEffect(() => {
    const handler = () => logout();
    window.addEventListener(AUTH_LOGOUT_EVENT, handler);
    return () => window.removeEventListener(AUTH_LOGOUT_EVENT, handler);
  }, [logout]);

  const login = useCallback(async (email: string, password: string) => {
    const { accessToken, refreshToken, user: signedIn } = await api.post<LoginResponse>(
      "/api/auth/login",
      { email, password },
    );

    // Tokens go into the store before state, so any request fired by the re-render that follows
    // already has one to attach.
    setTokens({ accessToken, refreshToken });
    setStoredUser(signedIn);
    setUser(signedIn);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, ready, login, logout }),
    [user, ready, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
