import type { Metadata } from "next";
import { Shield, Lock } from "lucide-react";
import { UserMenu } from "@/components/user-menu";

export const metadata: Metadata = {
  title: "VaultDrive — My Drive",
  description: "Browse your encrypted Google Drive metadata",
};

export default function DriveLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Top header */}
      <header className="sticky top-0 z-40 border-b border-white/8 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
          {/* Logo / brand */}
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-600/20 border border-violet-500/30">
              <Lock className="h-3.5 w-3.5 text-violet-400" />
            </div>
            <span>VaultDrive</span>
          </div>

          <div className="flex flex-1 items-center justify-end gap-3">
            {/* Security indicator */}
            <div className="hidden items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-400 sm:flex">
              <Shield className="h-3 w-3" />
              Client-side decryption
            </div>
            <UserMenu />
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
        {children}
      </main>
    </div>
  );
}
