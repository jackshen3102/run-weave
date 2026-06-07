import {
  IonApp,
  IonButton,
  IonContent,
  IonHeader,
  IonPage,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/react';

import { useHelloStore } from './store/use-hello-store';

function App() {
  const greeting = useHelloStore((state) => state.greeting);
  const count = useHelloStore((state) => state.count);
  const increment = useHelloStore((state) => state.increment);

  return (
    <IonApp>
      <IonPage>
        <IonHeader translucent>
          <IonToolbar>
            <IonTitle>Runweave</IonTitle>
          </IonToolbar>
        </IonHeader>
        <IonContent fullscreen>
          <main className="hello-screen">
            <section className="hello-panel" aria-labelledby="hello-title">
              <p className="hello-kicker">Ionic React + iOS</p>
              <h1 id="hello-title">{greeting}</h1>
              <IonText color="medium">
                <p>Ready for the next mobile capabilities.</p>
              </IonText>
              <IonButton expand="block" onClick={increment}>
                Tap {count === 1 ? '1 time' : `${count} times`}
              </IonButton>
            </section>
          </main>
        </IonContent>
      </IonPage>
    </IonApp>
  );
}

export default App;
