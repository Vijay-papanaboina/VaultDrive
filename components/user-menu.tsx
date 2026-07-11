"use client";

import { useState, useEffect } from "react";
import { signOut, useSession } from "@/lib/auth-client";
import { useCrypto } from "@/hooks/use-crypto";
import { identityToRecipient } from "age-encryption";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KeyRound, Copy, Check, Eye, EyeOff, LogOut, Shield } from "lucide-react";

interface AgeKeysDialogProps {
  isOpen: boolean;
  onClose: () => void;
  identity: string;
}

function AgeKeysDialog({ isOpen, onClose, identity }: AgeKeysDialogProps) {
  const [recipient, setRecipient] = useState<string>("");
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [copiedPublic, setCopiedPublic] = useState(false);
  const [copiedPrivate, setCopiedPrivate] = useState(false);

  useEffect(() => {
    if (isOpen && identity) {
      identityToRecipient(identity)
        .then(setRecipient)
        .catch(console.error);
    }
  }, [isOpen, identity]);

  const copyToClipboard = async (text: string, type: "public" | "private") => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === "public") {
        setCopiedPublic(true);
        setTimeout(() => setCopiedPublic(false), 2000);
      } else {
        setCopiedPrivate(true);
        setTimeout(() => setCopiedPrivate(false), 2000);
      }
    } catch (err) {
      console.error("Failed to copy text: ", err);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent id="age-keys-dialog" className="sm:max-w-md border-white/10 bg-background/95 backdrop-blur-xl">
        <DialogHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/15">
            <KeyRound className="h-5 w-5 text-violet-400" />
          </div>
          <DialogTitle className="text-foreground">Your Derived Age Keys</DialogTitle>
          <DialogDescription className="text-muted-foreground text-xs leading-normal">
            These keys are deterministically generated from your passphrase. Use them with the VaultDrive CLI tool to encrypt your files.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* Public Key */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Public Key (Recipient)
            </label>
            <div className="relative flex items-center">
              <input
                readOnly
                value={recipient || "Generating..."}
                className="w-full rounded-lg border border-white/8 bg-white/3 py-2 pl-3 pr-10 font-mono text-xs text-foreground focus-visible:outline-none"
              />
              <button
                id="copy-public-key-btn"
                onClick={() => copyToClipboard(recipient, "public")}
                disabled={!recipient}
                className="absolute right-2 text-muted-foreground hover:text-foreground disabled:opacity-50"
                title="Copy public key"
              >
                {copiedPublic ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* Private Key */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Private Key (Identity)
            </label>
            <div className="relative flex items-center">
              <input
                readOnly
                type={showPrivateKey ? "text" : "password"}
                value={identity}
                className="w-full rounded-lg border border-white/8 bg-white/3 py-2 pl-3 pr-20 font-mono text-xs text-foreground focus-visible:outline-none"
              />
              <div className="absolute right-2 flex items-center gap-2">
                <button
                  id="toggle-private-key-btn"
                  onClick={() => setShowPrivateKey(!showPrivateKey)}
                  className="text-muted-foreground hover:text-foreground"
                  title={showPrivateKey ? "Hide private key" : "Show private key"}
                >
                  {showPrivateKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
                <button
                  id="copy-private-key-btn"
                  onClick={() => copyToClipboard(identity, "private")}
                  className="text-muted-foreground hover:text-foreground"
                  title="Copy private key"
                >
                  {copiedPrivate ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-2 text-[11px] text-amber-400 bg-amber-500/5 border border-amber-500/20 rounded-lg p-2.5 leading-normal">
          <strong>Security Warning:</strong> Never share your Private Key with anyone. It can be used to decrypt all your metadata files.
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function UserMenu() {
  const { data: session } = useSession();
  const { getPassphrase } = useCrypto();
  const [isKeysOpen, setIsKeysOpen] = useState(false);
  const user = session?.user;
  const identity = getPassphrase();

  if (!user) return null;

  const initials = user.name
    ? user.name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)
    : "?";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          id="user-menu-trigger"
          className="flex items-center gap-2 rounded-full p-0.5 transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="User menu"
        >
          <Avatar className="h-8 w-8 border border-white/10">
            <AvatarImage src={user.image ?? undefined} alt={user.name ?? "User"} />
            <AvatarFallback className="bg-violet-600 text-xs text-white">
              {initials}
            </AvatarFallback>
          </Avatar>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-56">
          <div className="px-2 py-1.5">
            <p className="text-sm font-medium">{user.name}</p>
            <p className="text-xs text-muted-foreground">{user.email}</p>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="gap-2 text-muted-foreground" disabled>
            <Shield className="h-3.5 w-3.5" />
            drive.readonly access
          </DropdownMenuItem>
          {identity && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                id="view-keys-btn"
                className="gap-2 text-foreground focus:text-foreground cursor-pointer"
                onClick={() => setIsKeysOpen(true)}
              >
                <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                View age keys
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            id="sign-out-btn"
            className="gap-2 text-destructive focus:text-destructive"
            onClick={() => signOut({ fetchOptions: { onSuccess: () => { window.location.href = "/"; } } })}
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {identity && (
        <AgeKeysDialog
          isOpen={isKeysOpen}
          onClose={() => setIsKeysOpen(false)}
          identity={identity}
        />
      )}
    </>
  );
}
