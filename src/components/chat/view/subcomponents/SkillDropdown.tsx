import React, { useState, useEffect, useRef } from 'react';
import type { AttachedPrompt } from '../../types/types';
import { SKILL_CATEGORIES } from '../../constants/skillCategories';

interface SkillDropdownProps {
  setInput: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  setAttachedPrompt?: (prompt: AttachedPrompt | null) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export default function SkillDropdown({
  setInput,
  textareaRef,
  setAttachedPrompt,
  t,
}: SkillDropdownProps) {
  const [open, setOpen] = useState(false);
  const [expandedCat, setExpandedCat] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setExpandedCat(null);
      }
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const inject = (prompt: string, icon: string, title: string, categoryKey: string) => {
    if (setAttachedPrompt) {
      setAttachedPrompt({
        scenarioId: `skill-${categoryKey}`,
        scenarioIcon: icon,
        scenarioTitle: title,
        promptText: prompt,
      });
      setTimeout(() => textareaRef.current?.focus(), 100);
    } else {
      setInput((prev: string) => prev ? `${prompt}\n\n${prev}` : prompt);
      setTimeout(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
      }, 100);
    }
    setOpen(false);
    setExpandedCat(null);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-border/50 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-all duration-150"
      >
        <span>⚡</span>
        <span>{t('skillShortcuts.title')}</span>
        <svg className="w-3 h-3 text-muted-foreground/60 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-50 bottom-full mb-1 left-0 w-64 max-h-[320px] bg-popover border border-border rounded-xl shadow-xl overflow-y-auto">
          {SKILL_CATEGORIES.map((cat) => {
            const isExpanded = expandedCat === cat.key;
            return (
              <div key={cat.key}>
                <button
                  type="button"
                  onClick={() => setExpandedCat(isExpanded ? null : cat.key)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-[11px] transition-colors ${
                    isExpanded ? 'bg-primary/8 text-foreground font-medium' : 'hover:bg-muted/50 text-muted-foreground'
                  }`}
                >
                  <span className="text-sm leading-none">{cat.icon}</span>
                  <span className="flex-1">{t(`skillShortcuts.categories.${cat.key}`)}</span>
                  <span className="text-[9px] text-muted-foreground/60">{cat.skills.length}</span>
                </button>
                {isExpanded && (
                  <div className="px-3 pb-2">
                    <div className="flex flex-wrap gap-1">
                      {cat.skills.map((skill) => (
                        <button
                          key={skill}
                          type="button"
                          onClick={() => inject(
                            t('skillShortcuts.promptSingle', { skill }),
                            cat.icon,
                            t(`skillShortcuts.categories.${cat.key}`),
                            cat.key,
                          )}
                          className="px-2 py-0.5 text-[10px] font-medium rounded-full border border-border/50 bg-background hover:bg-muted hover:border-border transition-colors text-foreground"
                        >
                          {skill}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => inject(
                        t('skillShortcuts.promptMulti', { skills: cat.skills.join(', ') }),
                        cat.icon,
                        t(`skillShortcuts.categories.${cat.key}`),
                        cat.key,
                      )}
                      className="mt-1.5 text-[10px] font-medium text-primary hover:text-primary/80 transition-colors"
                    >
                      {t('skillShortcuts.useAll')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
