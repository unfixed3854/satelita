/// <reference types="vite/client" />
import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppNav } from "@/components/app-nav";
import appCss from "../app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "satelita" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/vite.svg" },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="flex h-screen flex-col overflow-hidden">
        <AppNav />
        {children}
        <Scripts />
      </body>
    </html>
  );
}
