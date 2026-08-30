import type { Metadata } from "next";
import { PassphraseGate } from "@/components/passphrase-gate";
import { SelectionProvider } from "@/components/selection-provider";
import { DriveHeader } from "@/components/drive-header";
import { FileDownloadProvider } from "@/components/file-download-provider";
import { FileUploadProvider } from "@/components/file-upload-provider";

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
    <SelectionProvider>
      <FileDownloadProvider>
        <FileUploadProvider>
        <div className="flex min-h-screen flex-col">
          {/* Top header */}
          <DriveHeader />

          {/* Main content — gated behind passphrase */}
          <PassphraseGate>
            <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
              {children}
            </main>
          </PassphraseGate>
        </div>
        </FileUploadProvider>
      </FileDownloadProvider>
    </SelectionProvider>
  );
}
