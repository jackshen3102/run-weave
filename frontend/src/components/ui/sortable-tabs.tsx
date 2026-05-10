import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";
import {
  DndContext,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";

export interface SortableTabRenderProps {
  isDragging: boolean;
}

interface SortableTabsProps<T> {
  items: T[];
  getItemId: (item: T) => string;
  onReorder: (fromIndex: number, toIndex: number) => void;
  renderTab: (item: T, props: SortableTabRenderProps) => ReactNode;
  className?: string;
}

interface SortableTabItemProps {
  id: string;
  children: ReactNode;
}

function SortableTabItem({ id, children }: SortableTabItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    position: "relative",
    touchAction: "none",
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}

export function SortableTabs<T>({
  items,
  getItemId,
  onReorder,
  renderTab,
  className,
}: SortableTabsProps<T>) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const ids = useMemo(() => items.map((item) => getItemId(item)), [items, getItemId]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
        delay: 150,
        tolerance: 5,
      },
    }),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const index = ids.indexOf(String(event.active.id));
      if (index >= 0) {
        setActiveIndex(index);
      }
    },
    [ids],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveIndex(null);
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }

      const fromIndex = ids.indexOf(String(active.id));
      const toIndex = ids.indexOf(String(over.id));
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
        return;
      }

      onReorder(fromIndex, toIndex);
    },
    [ids, onReorder],
  );

  const activeItem =
    activeIndex !== null && activeIndex >= 0 && activeIndex < items.length
      ? items[activeIndex]
      : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      modifiers={[restrictToHorizontalAxis]}
    >
      <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
        <div className={className}>
          {items.map((item) => (
            <SortableTabItem key={getItemId(item)} id={getItemId(item)}>
              {renderTab(item, { isDragging: false })}
            </SortableTabItem>
          ))}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeItem
          ? renderTab(activeItem, { isDragging: true })
          : null}
      </DragOverlay>
    </DndContext>
  );
}
