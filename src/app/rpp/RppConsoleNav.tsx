"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

type NavItem = { key: string; label: string };

export default function RppConsoleNav({ activeView, items }: { activeView: string; items: NavItem[] }) {
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    const active = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [activeView]);

  return (
    <nav ref={navRef}>
      {items.map((item) => (
        <Link
          className={activeView === item.key ? "active" : ""}
          href={`/rpp?view=${item.key}`}
          aria-current={activeView === item.key ? "page" : undefined}
          key={item.key}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
