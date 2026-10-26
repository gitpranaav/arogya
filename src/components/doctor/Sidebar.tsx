"use client";

import { motion } from "framer-motion";
import { LayoutGrid, PanelLeftClose, PanelLeftOpen, Settings, Stethoscope, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { Avatar } from "@/src/components/ui/Avatar";
import { cn } from "@/src/lib/utils";

const NAV_ITEMS = [
  { href: "/doctor", label: "Dashboard", icon: LayoutGrid },
  { href: "/doctor/patients", label: "Patients", icon: Users },
  { href: "/doctor/consultations", label: "Consultations", icon: Stethoscope },
  { href: "/doctor/settings", label: "Settings", icon: Settings },
];

interface SidebarContentProps {
  collapsed: boolean;
  doctorName: string;
  doctorSpecialization: string;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
  trailing?: ReactNode;
}

function SidebarContent({ collapsed, doctorName, doctorSpecialization, onToggleCollapsed, onNavigate, trailing }: SidebarContentProps) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      <div className={cn("flex items-center justify-between gap-2 border-b border-[hsl(var(--border))] px-4 py-3", collapsed ? "px-3" : "px-4")}>
        <p className={cn("font-semibold tracking-tight text-[hsl(var(--text-primary))]", collapsed ? "text-center text-sm" : "text-lg")}>
          {collapsed ? "MF" : "MediFlow"}
        </p>
        {onToggleCollapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] text-[hsl(var(--text-secondary))] hover:bg-[hsl(var(--bg-secondary))]"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
        ) : null}
      </div>

      <nav className="mt-2 flex-1 space-y-1 px-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active =
            pathname === item.href || (item.href !== "/doctor" && pathname.startsWith(`${item.href}/`));

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                "group relative flex h-11 items-center rounded-[calc(var(--radius)-2px)] border border-transparent px-3 text-sm transition-all duration-200",
                "hover:bg-[hsl(var(--bg-card))] hover:text-[hsl(var(--text-primary))]",
                active
                  ? "bg-[hsl(var(--accent)/0.12)] text-[hsl(var(--accent))]"
                  : "text-[hsl(var(--text-secondary))]"
              )}
              title={collapsed ? item.label : undefined}
            >
              {active ? <span className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-[hsl(var(--accent))]" /> : null}
              <Icon className={cn("h-4 w-4 shrink-0", collapsed ? "mx-auto" : "")} />
              {!collapsed ? <span className="ml-3">{item.label}</span> : null}
            </Link>
          );
        })}
      </nav>

      <div className="mt-4 border-t border-[hsl(var(--border))] p-3">
        <div
          className={cn(
            "flex items-center rounded-[var(--radius)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-2.5 shadow-[var(--shadow-sm)]",
            collapsed ? "justify-center" : "gap-3"
          )}
        >
          <Avatar size={collapsed ? "sm" : "md"} name={doctorName} />
          {!collapsed ? (
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-[hsl(var(--text-primary))]">{doctorName}</p>
              <p className="truncate text-xs text-[hsl(var(--text-muted))]">{doctorSpecialization}</p>
            </div>
          ) : null}
        </div>
      </div>
      {trailing}
    </div>
  );
}

interface SidebarProps {
  collapsed: boolean;
  mobileOpen: boolean;
  setMobileOpen: (value: boolean) => void;
  onToggleCollapsed: () => void;
  doctorName: string;
  doctorSpecialization: string;
}

export function Sidebar({ collapsed, mobileOpen, setMobileOpen, onToggleCollapsed, doctorName, doctorSpecialization }: SidebarProps) {
  return (
    <>
      <motion.aside
        animate={{ width: collapsed ? 64 : 240 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="hidden h-screen shrink-0 border-r border-[hsl(var(--border))] bg-[hsl(var(--bg-secondary))] lg:block print:hidden"
      >
        <SidebarContent
          collapsed={collapsed}
          doctorName={doctorName}
          doctorSpecialization={doctorSpecialization}
          onToggleCollapsed={onToggleCollapsed}
        />
      </motion.aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden print:hidden">
          <button
            aria-label="Close navigation overlay"
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileOpen(false)}
          />
          <motion.aside
            initial={{ x: -280 }}
            animate={{ x: 0 }}
            exit={{ x: -280 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="relative z-50 h-full w-[280px] border-r border-[hsl(var(--border))] bg-[hsl(var(--bg-secondary))]"
          >
            <SidebarContent
              collapsed={false}
              doctorName={doctorName}
              doctorSpecialization={doctorSpecialization}
              onNavigate={() => setMobileOpen(false)}
              trailing={
                <button
                  className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full text-[hsl(var(--text-muted))] hover:bg-[hsl(var(--bg-card))]"
                  onClick={() => setMobileOpen(false)}
                  aria-label="Close menu"
                >
                  <X className="h-4 w-4" />
                </button>
              }
            />
          </motion.aside>
        </div>
      ) : null}
    </>
  );
}
