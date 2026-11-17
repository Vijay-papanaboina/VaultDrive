import type { Metadata } from "next";
import { LocalDownloadsPage } from "@/components/local-downloads-page";

export const metadata: Metadata = {
  title: "VaultDrive: Encrypted Downloads",
  description: "Your encrypted local library and VLC playback.",
};

export default function Downloads() {
  return <LocalDownloadsPage />;
}
