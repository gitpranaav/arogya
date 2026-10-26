"use client";

import { Bell, ChevronDown, Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { ThemeToggle } from "@/src/components/theme/ThemeToggle";
import { Avatar } from "@/src/components/ui/Avatar";
import { cn } from "@/src/lib/utils";

const PAGE_TITLES: Record<string, string> = {
  "/doctor": "Dashboard",
  "/doctor/patients": "Patients",
  "/doctor/consultations": "Consultations",
  "/doctor/settings": "Settings",
};

function getPageTitle(pathname: string) {
  if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname];
  const prefix = Object.keys(PAGE_TITLES).find((route) => route !== "/doctor" && pathname.startsWith(`${route}/`));
  return prefix ? PAGE_TITLES[prefix] : "MediFlow";
}

interface HeaderProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenMobileMenu: () => void;
  doctorName: string;
}

export function Header({ collapsed, onToggleCollapsed, onOpenMobileMenu, doctorName }: HeaderProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const pageTitle = useMemo(() => getPageTitle(pathname), [pathname]);

  const handleLogout = async () => {
    setMenuOpen(false);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  };

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--bg-primary)/0.88)] px-4 backdrop-blur md:px-6 print:hidden">
      <div className="flex items-center gap-2 md:gap-3">
        <button
          onClick={onOpenMobileMenu}
          className="inline-flex h-9 w-9 items-center justify-center rounded-[calc(var(--radius)-2px)] text-[hsl(var(--text-secondary))] hover:bg-[hsl(var(--bg-secondary))] lg:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-4 w-4" />
        </button>
        <button
          onClick={onToggleCollapsed}
          className="hidden h-9 w-9 items-center justify-center rounded-[calc(var(--radius)-2px)] text-[hsl(var(--text-secondary))] hover:bg-[hsl(var(--bg-secondary))] lg:inline-flex"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
        <div>
          <h1 className="text-sm font-semibold text-[hsl(var(--text-primary))] md:text-base">{pageTitle}</h1>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          aria-label="Safety alerts"
          className="relative inline-flex h-10 w-10 items-center justify-center rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] text-[hsl(var(--text-secondary))] shadow-[var(--shadow-sm)] transition-colors hover:bg-[hsl(var(--bg-secondary))]"
        >
          <Bell className="h-4 w-4" />
          <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-[hsl(var(--danger))]" />
        </button>
        <ThemeToggle />

        <div className="relative">
          <button
            onClick={() => setMenuOpen((prev) => !prev)}
            className={cn(
              "inline-flex h-10 items-center gap-2 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] px-1.5 pr-2 shadow-[var(--shadow-sm)] transition-colors hover:bg-[hsl(var(--bg-secondary))]",
              menuOpen ? "ring-2 ring-[hsl(var(--accent))] ring-offset-2 ring-offset-[hsl(var(--bg-primary))]" : ""
            )}
            aria-label="Profile menu"
            aria-expanded={menuOpen}
          >
            <Avatar size="sm" name={doctorName} />
            <ChevronDown className="h-4 w-4 text-[hsl(var(--text-muted))]" />
          </button>
          {menuOpen ? (
            <div className="absolute right-0 z-40 mt-2 min-w-40 rounded-[var(--radius)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-1 shadow-[var(--shadow-md)]">
              <button
                className="block w-full rounded-[calc(var(--radius)-4px)] px-3 py-2 text-left text-sm text-[hsl(var(--text-primary))] hover:bg-[hsl(var(--bg-secondary))]"
                onClick={() => setMenuOpen(false)}
              >
                Profile
              </button>
              <button
                className="block w-full rounded-[calc(var(--radius)-4px)] px-3 py-2 text-left text-sm text-[hsl(var(--danger))] hover:bg-[hsl(var(--bg-secondary))]"
                onClick={handleLogout}
              >
                Logout
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
