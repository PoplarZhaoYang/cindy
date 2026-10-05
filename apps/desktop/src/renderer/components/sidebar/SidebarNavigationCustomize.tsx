import { useState } from 'react';
import { Check, GripVertical, Puzzle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useGhostMainViews } from '@/cindy-brain/ghostMainViews';
import { useAuth } from '@/contexts/AuthContext';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { MAIN_VIEW_ICONS } from './GhostMainViewNavEntries';
import {
  DEFAULT_SIDEBAR_NAVIGATION_VISIBLE,
  SIDEBAR_NAVIGATION_ITEMS,
  SIDEBAR_NAVIGATION_ITEM_ICONS,
  appEntryId,
  getSidebarKnownApps,
  getSidebarNavigationPrefs,
  ghostIdOfEntry,
  isBuiltInEntry,
  resolveSidebarNavigationOrder,
  setSidebarNavigationPrefs,
  type SidebarNavigationAppEntryId,
  type SidebarNavigationEntryId,
  type SidebarNavigationItemId,
  useSidebarNavigationPrefs,
} from './sidebarNavigationPrefs';
import { SortableList } from './SortableList';

interface SidebarNavigationCustomizeProps {
  onDone: () => void;
}

interface CustomizeDraft {
  order: SidebarNavigationEntryId[];
  /** Built-in entries shown at the top level. */
  visible: ReadonlySet<SidebarNavigationItemId>;
  /** Plugin main views moved into More; unlisted plugins sit at the top level. */
  appsInMore: ReadonlySet<SidebarNavigationAppEntryId>;
}

/**
 * 管理一级入口(含带主视图的插件)的勾选与顺序；草稿在“完成”时一次性提交，
 * 取消离开不会改偏好。勾选只决定入口在最外层还是收进「更多」；插件是否进侧边栏
 * 由插件自己的「在侧边栏显示」开关决定，关掉的插件不会出现在这里。
 */
export function SidebarNavigationCustomize({ onDone }: SidebarNavigationCustomizeProps) {
  const { t } = useTranslation();
  const { dataOwnerId } = useAuth();
  const prefs = useSidebarNavigationPrefs(dataOwnerId);
  const { sidebarVisible } = useGhostMainViews();
  const appIds = sidebarVisible.map((item) => item.ghostId);
  const apps = new Map(sidebarVisible.map((item) => [item.ghostId, item]));
  const [initial] = useState<CustomizeDraft>(() => ({
    order: resolveSidebarNavigationOrder(prefs.order, appIds),
    visible: new Set(prefs.visible),
    appsInMore: new Set(prefs.appsInMore),
  }));
  const [draft, setDraft] = useState<CustomizeDraft>(initial);
  const reducedMotion = useReducedMotion();
  const [resetting, setResetting] = useState(false);

  // Plugins switched on or off while the panel is open join or leave the list.
  const orderedItems = resolveSidebarNavigationOrder(draft.order, appIds);
  const checkedIn = (state: CustomizeDraft, id: SidebarNavigationEntryId) =>
    isBuiltInEntry(id)
      ? state.visible.has(id)
      : !state.appsInMore.has(id as SidebarNavigationAppEntryId);
  const isChecked = (id: SidebarNavigationEntryId) => checkedIn(draft, id);
  const labelFor = (id: SidebarNavigationEntryId) => {
    const ghostId = ghostIdOfEntry(id);
    return ghostId === null
      ? t('sidebar.navigation.items.' + id)
      : (apps.get(ghostId)?.title ?? ghostId);
  };
  // The same icon the entry shows in the sidebar, so each row is recognisable at a glance.
  const iconFor = (id: SidebarNavigationEntryId) => {
    const ghostId = ghostIdOfEntry(id);
    if (ghostId === null) return SIDEBAR_NAVIGATION_ITEM_ICONS[id as SidebarNavigationItemId];
    const app = apps.get(ghostId);
    return app ? MAIN_VIEW_ICONS[app.icon] : Puzzle;
  };
  const toggle = (id: SidebarNavigationEntryId) => {
    setDraft((current) => {
      if (isBuiltInEntry(id)) {
        const visible = new Set(current.visible);
        if (visible.has(id)) visible.delete(id);
        else visible.add(id);
        return { ...current, visible };
      }
      const appId = id as SidebarNavigationAppEntryId;
      const appsInMore = new Set(current.appsInMore);
      if (appsInMore.has(appId)) appsInMore.delete(appId);
      else appsInMore.add(appId);
      return { ...current, appsInMore };
    });
  };
  const move = (source: SidebarNavigationEntryId, target: SidebarNavigationEntryId) => {
    if (source === target) return;
    setDraft((current) => {
      const order = resolveSidebarNavigationOrder(current.order, appIds);
      const sourceIndex = order.indexOf(source);
      const targetIndex = order.indexOf(target);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = order.filter((id) => id !== source);
      // Downward drops go after the target; upward drops go before it.
      next.splice(targetIndex, 0, source);
      return { ...current, order: next };
    });
  };
  const moveBy = (id: SidebarNavigationEntryId, direction: -1 | 1) => {
    const index = orderedItems.indexOf(id);
    const target = orderedItems[index + direction];
    if (target) move(id, target);
  };
  const save = () => {
    if (resetting) {
      // The default order leaves every plugin after the built-ins, so future defaults still apply.
      // Plugins default to More, like a new arrival: those listed here follow the draft
      // (they may be re-checked after resetting), and plugins whose own sidebar switch is
      // off right now also go to More, so switching one back on never lands it at the top.
      const listed = new Set(appIds.map(appEntryId));
      const offPanel = [
        ...getSidebarKnownApps(dataOwnerId).map(appEntryId),
        ...getSidebarNavigationPrefs(dataOwnerId).appsInMore,
      ].filter((id) => !listed.has(id));
      setSidebarNavigationPrefs(dataOwnerId, {
        order: [...SIDEBAR_NAVIGATION_ITEMS],
        visible: SIDEBAR_NAVIGATION_ITEMS.filter((id) => draft.visible.has(id)),
        appsInMore: [...new Set([...draft.appsInMore, ...offPanel])],
      });
      onDone();
      return;
    }
    // Preserve edits made in another window while this draft was open: only entries
    // toggled here override the latest saved state.
    const latest = getSidebarNavigationPrefs(dataOwnerId);
    const latestState: CustomizeDraft = {
      order: latest.order,
      visible: new Set(latest.visible),
      appsInMore: new Set(latest.appsInMore),
    };
    const resolve = (id: SidebarNavigationEntryId) =>
      checkedIn(draft, id) !== checkedIn(initial, id)
        ? checkedIn(draft, id)
        : checkedIn(latestState, id);
    const orderChanged =
      orderedItems.length !== initial.order.length ||
      orderedItems.some((id, index) => id !== initial.order[index]);
    // Plugins absent from the panel (sidebar switch off) keep whatever was saved for them.
    const appEntries = new Set<SidebarNavigationAppEntryId>([
      ...latest.appsInMore,
      ...appIds.map(appEntryId),
    ]);
    setSidebarNavigationPrefs(dataOwnerId, {
      order: orderChanged ? orderedItems : latest.order,
      visible: SIDEBAR_NAVIGATION_ITEMS.filter(resolve),
      appsInMore: [...appEntries].filter((id) => !resolve(id)),
    });
    onDone();
  };

  return (
    <div
      role="dialog"
      aria-label={t('sidebar.navigation.customize.title')}
      className="mx-2 mb-2 rounded-xl border border-sidebar-border bg-[var(--surface-elevated)] p-3 shadow-[var(--shadow-menu)]"
    >
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <h2 className="text-sm font-medium text-[var(--text-primary)]">
          {t('sidebar.navigation.customize.title')}
        </h2>
        <Button variant="primary" size="sm" compact onClick={save}>
          {t('sidebar.navigation.customize.done')}
        </Button>
      </div>
      {/* Pointer-driven sort shared with the sidebar lists: the whole row floats with
          the cursor and the others make room live, so the drop position is visible. */}
      <SortableList
        items={orderedItems}
        getId={(id) => id}
        onReorder={(ids) =>
          setDraft((current) => ({
            ...current,
            order: ids as SidebarNavigationEntryId[],
          }))
        }
        reducedMotion={reducedMotion}
        // Rows drag from their label or handle; only the checkbox stays a plain click.
        filter="[role='checkbox']"
        className="flex flex-col gap-0.5"
        renderItem={(id) => {
          const visible = isChecked(id);
          const Icon = iconFor(id);
          return (
            // The whole row toggles; the checkbox stays the focusable control, and its
            // keyboard activation bubbles here as the same click.
            <div
              onClick={() => toggle(id)}
              className="group/nav-entry flex h-9 cursor-pointer items-center gap-2 rounded-lg px-1 hover:bg-sidebar-item-hover"
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={visible}
                aria-label={labelFor(id)}
                // Same round selection mark as ShareMessageCheckbox: inverse fill when
                // checked, a neutral outline otherwise. Blue stays reserved for focus.
                className={cn(
                  'grid size-5 shrink-0 place-items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                  visible
                    ? 'bg-[var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)]'
                    : 'border border-[var(--border-default)] group-hover/nav-entry:border-[var(--text-secondary)]',
                )}
              >
                {visible && <Check size={12} strokeWidth={2.5} aria-hidden />}
              </button>
              <Icon
                aria-hidden="true"
                size={15}
                strokeWidth={1.8}
                className="shrink-0 text-[var(--sidebar-nav-text)]"
              />
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">
                {labelFor(id)}
              </span>
              <Tip
                text={t('sidebar.navigation.customize.reorder', { name: labelFor(id) })}
                side="right"
              >
                <button
                  type="button"
                  aria-label={t('sidebar.navigation.customize.reorder', { name: labelFor(id) })}
                  aria-keyshortcuts="ArrowUp ArrowDown"
                  // The handle is for dragging and arrow-key moves, not for toggling.
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                      event.preventDefault();
                      moveBy(id, event.key === 'ArrowUp' ? -1 : 1);
                    }
                  }}
                  className="grid size-7 shrink-0 cursor-grab place-items-center rounded-lg text-[var(--text-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <GripVertical aria-hidden="true" size={16} />
                </button>
              </Tip>
            </div>
          );
        }}
      />
      <Button
        variant="primary"
        tone="quiet"
        size="sm"
        compact
        className="mt-2"
        onClick={() => {
          setDraft({
            order: resolveSidebarNavigationOrder(SIDEBAR_NAVIGATION_ITEMS, appIds),
            visible: new Set(DEFAULT_SIDEBAR_NAVIGATION_VISIBLE),
            // Plugins default to More, the same place a newly arrived plugin starts.
            appsInMore: new Set(appIds.map(appEntryId)),
          });
          setResetting(true);
        }}
      >
        {t('sidebar.navigation.customize.reset')}
      </Button>
    </div>
  );
}
