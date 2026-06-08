import { IonApp } from "@ionic/react";
import { IonReactRouter } from "@ionic/react-router";

import { useAppSession } from "./hooks/use-app-session";
import { AppRoutes } from "./routes/AppRoutes";

function App() {
  const session = useAppSession();

  if (session.startupState === "checking") {
    return <IonApp className="app-loading" />;
  }

  return (
    <IonApp>
      <IonReactRouter>
        <AppRoutes session={session} />
      </IonReactRouter>
    </IonApp>
  );
}

export default App;
