import { useLocation, useNavigate } from "react-router-dom";
export function SettingsTabs({
  items,
  active,
}: {
  items: readonly (readonly [string, string])[];
  active: string;
}) {
  const location = useLocation(),
    navigate = useNavigate();
  return (
    <nav className="settings-tabs" aria-label="页面分类">
      {items.map(([id, label]) => (
        <button
          key={id}
          aria-current={active === id ? "page" : undefined}
          onClick={() => {
            const query = new URLSearchParams(location.search);
            query.set("section", id);
            navigate(`${location.pathname}?${query}`, {
              state: location.state,
            });
          }}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
