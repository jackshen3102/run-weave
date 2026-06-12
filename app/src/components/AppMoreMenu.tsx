import {
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonPopover,
} from "@ionic/react";
import { ellipsisVertical } from "ionicons/icons";
import { useState } from "react";

export interface AppMoreMenuItem {
  label: string;
  onClick: () => void;
  tone?: "danger";
}

export function AppMoreMenu({
  ariaLabel = "More actions",
  className,
  items,
}: {
  ariaLabel?: string;
  className?: string;
  items: AppMoreMenuItem[];
}) {
  const [popoverEvent, setPopoverEvent] = useState<Event | null>(null);

  return (
    <span className={["app-more-menu", className].filter(Boolean).join(" ")}>
      <button
        aria-label={ariaLabel}
        className="app-more-menu__trigger"
        onClick={(event) => setPopoverEvent(event.nativeEvent)}
        type="button"
      >
        <IonIcon aria-hidden="true" icon={ellipsisVertical} />
      </button>
      <IonPopover
        dismissOnSelect
        event={popoverEvent}
        isOpen={popoverEvent !== null}
        onDidDismiss={() => setPopoverEvent(null)}
      >
        <IonList className="app-more-menu__list">
          {items.map((item) => (
            <IonItem
              button
              color={item.tone}
              detail={false}
              key={item.label}
              onClick={item.onClick}
            >
              <IonLabel>{item.label}</IonLabel>
            </IonItem>
          ))}
        </IonList>
      </IonPopover>
    </span>
  );
}
