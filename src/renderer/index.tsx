// @ts-nocheck
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import 'highlight.js/styles/github-dark.css';

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
