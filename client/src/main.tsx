import React, { useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { DbConnection } from './module_bindings';
import { MODULE_NAME, SPACETIMEDB_URI } from './config';
import App from './App';
import './styles.css';

const TOKEN_STORAGE_KEY = `ydrive:auth-token:${MODULE_NAME}`;

function readStoredToken() {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

function storeToken(token: string) {
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Ownership lasts for the current connection when storage is unavailable.
  }
}

function Root() {
  const connectionBuilder = useMemo(
    () =>
      DbConnection.builder()
        .withUri(SPACETIMEDB_URI)
        .withDatabaseName(MODULE_NAME)
        .withToken(readStoredToken())
        .onConnect((_connection, _identity, token) => storeToken(token)),
    []
  );

  return (
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
