"use client";
import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import heatSynQLogo from "@/assets/brand/heatsynq-logo-light.png";
import { getBrowserDraftSession } from "@/lib/draft-session";
import { api } from "@/lib/fetcher";
import { BUTTON_PRIMARY_COMPACT, INPUT_COMPACT } from "@/lib/ui-classes";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      getBrowserDraftSession()?.loginSucceeded();
      router.push("/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-50">
      <form onSubmit={submit} className="w-80 rounded-lg bg-surface-0 p-6 shadow">
        <Image src={heatSynQLogo} alt="HeatSynQ" className="mb-4 h-auto w-full" sizes="272px" preload />
        <h1 className="mb-4 text-xl font-semibold">Sign in</h1>
        <label className="mb-2 block text-sm">
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus
            className={`${INPUT_COMPACT} mt-1 w-full`} />
        </label>
        <label className="mb-4 block text-sm">
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            className={`${INPUT_COMPACT} mt-1 w-full`} />
        </label>
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <button className={`${BUTTON_PRIMARY_COMPACT} w-full`}>Sign in</button>
      </form>
    </main>
  );
}
