import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

console.log('main.tsx starting...');

// Check if root element exists
const rootElement = document.getElementById("root");
console.log('Root element found:', !!rootElement);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    // Register/update service worker (don't unregister — it kills push subscriptions)
    navigator.serviceWorker.register('/service-worker.js')
      .then((registration) => {
        console.log('SW registrado:', registration.scope);
        // Check for updates
        registration.update();
      })
      .catch((error) => {
        console.log('Error registrando SW:', error);
      });
  });
}

console.log('Creating React root...');
try {
  const root = createRoot(rootElement!);
  console.log('React root created, rendering App...');
  root.render(<App />);
  console.log('App rendered successfully');
} catch (error) {
  console.error('Error rendering app:', error);
}

