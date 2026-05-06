import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { Home } from './pages/Home';
import { Configure } from './pages/Configure';
import { Runs } from './pages/Runs';
import { RunDetail } from './pages/RunDetail';
import './index.css';

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-3 text-sm">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <img src="/logo.png" alt="" className="h-7 w-7 rounded-sm" />
            Anvil
          </Link>
          <Link to="/runs" className="text-slate-600 hover:text-slate-900">Runs</Link>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/configure" element={<Configure />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<RunDetail />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  </React.StrictMode>,
);
