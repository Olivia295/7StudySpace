import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import App from './App';
import { StoreProvider } from './lib/store';
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><StoreProvider><App/></StoreProvider></React.StrictMode>);
if(import.meta.env.PROD&&'serviceWorker'in navigator)window.addEventListener('load',()=>{void navigator.serviceWorker.register('/sw.js').catch(()=>{});});
