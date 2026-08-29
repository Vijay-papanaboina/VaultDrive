"use client";

import { signIn, useSession } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Shield,
  Lock,
  FolderKey,
  Eye,
  ArrowRight,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

const features = [
  {
    icon: Lock,
    title: "Zero Knowledge",
    description:
      "Your decryption passphrase never leaves the browser. Age-encrypted files are decrypted entirely client-side.",
  },
  {
    icon: Eye,
    title: "Metadata First",
    description:
      "Browsing fetches lightweight .meta sidecar files. You can edit and save their encrypted details and thumbnails without changing the original payload files.",
  },
  {
    icon: FolderKey,
    title: "Lazy Folder Loading",
    description:
      "Metadata is fetched and decrypted per folder on demand. Nothing is fetched until you navigate to it.",
  },
];

export default function HomePage() {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (session) {
      router.replace("/drive");
    }
  }, [session, router]);

  async function handleGoogleSignIn() {
    setLoading(true);
    try {
      const res = await signIn.social({
        provider: "google",
        callbackURL: "/drive",
      });
      if (res?.error) {
        setLoading(false);
      }
    } catch {
      setLoading(false);
    }
  }

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-x-hidden px-4 py-12 sm:py-20">
      {/* Ambient background glows */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="absolute -left-40 -top-40 h-[600px] w-[600px] rounded-full bg-violet-600/10 blur-[120px]" />
        <div className="absolute -right-40 bottom-0 h-[500px] w-[500px] rounded-full bg-blue-600/10 blur-[120px]" />
        <div className="absolute left-1/2 top-1/2 h-[300px] w-[300px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-600/5 blur-[80px]" />
      </div>

      {/* Subtle grid overlay */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      <div className="relative z-10 flex w-full max-w-3xl flex-col items-center gap-10">
        {/* Badge */}
        <div className="flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-4 py-1.5 text-xs font-medium text-violet-300 backdrop-blur-sm">
          <Shield className="h-3.5 w-3.5" />
          Age-encrypted · Client-side decryption · Drive-readonly
        </div>

        {/* Headline */}
        <div className="flex flex-col items-center gap-4 text-center">
          <h1 className="text-5xl font-bold tracking-tight text-white sm:text-6xl">
            Your encrypted vault,{" "}
            <span className="bg-gradient-to-r from-violet-400 via-blue-400 to-emerald-400 bg-clip-text text-transparent">
              beautifully browsed
            </span>
          </h1>
          <p className="max-w-xl text-lg leading-relaxed text-muted-foreground">
            VaultDrive reads your age-encrypted{" "}
            <code className="rounded bg-white/5 px-1.5 py-0.5 text-sm font-mono text-white/80">
              .meta
            </code>{" "}
            sidecar files from Google Drive, decrypts them in your browser, and
            shows you a rich browsable view of your storage. Browsing stays
            lightweight, while requested original files stream and decrypt in
            your browser.
          </p>
        </div>

        {/* Sign-in card */}
        <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl">
          <div className="mb-5 flex flex-col gap-1">
            <h2 className="text-base font-semibold text-white">
              Connect your Drive
            </h2>
            <p className="text-sm text-muted-foreground">
              We update only encrypted metadata sidecars. Original payload files are never modified.
            </p>
          </div>

          <Button
            id="google-signin-btn"
            onClick={handleGoogleSignIn}
            disabled={loading || isPending || !!session}
            className="w-full gap-2.5 bg-white text-gray-900 hover:bg-gray-100 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
            size="lg"
          >
            {loading || isPending || !!session ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <GoogleIcon />
            )}
            {loading || isPending || !!session
              ? session
                ? "Redirecting…"
                : "Connecting…"
              : "Sign in with Google"}
            {!(loading || isPending || !!session) && (
              <ArrowRight className="ml-auto h-4 w-4" />
            )}
          </Button>

          <p className="mt-4 text-center text-xs text-muted-foreground">
            Requests <code className="text-white/60">drive</code> scope for reading and saving encrypted metadata
            only. Your passphrase is never sent anywhere.
          </p>
        </div>

        {/* Feature grid */}
        <div className="grid w-full gap-4 sm:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.title}
              className="flex flex-col gap-3 rounded-xl border border-white/8 bg-white/3 p-5 backdrop-blur-sm transition-colors hover:border-white/15 hover:bg-white/5"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-violet-500/30 bg-violet-500/15">
                <f.icon className="h-4 w-4 text-violet-400" />
              </div>
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-semibold text-white">{f.title}</h3>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {f.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <footer className="relative z-10 mt-16 text-center text-xs text-muted-foreground">
        VaultDrive · open source · decryption runs in your browser
      </footer>
    </main>
  );
}
