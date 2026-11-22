import React, { useEffect, useState } from 'react';
import Scene from './Scene.jsx';
import { STEPS, UI } from './steps.js';

function Code({ text, ui }) {
  const [ok, setOk] = useState(false);
  return (<div className="code"><button onClick={() => { navigator.clipboard?.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); }}>{ok ? ui.copied : ui.copy}</button><pre><code>{text}</code></pre></div>);
}

export default function App() {
  const [lang, setLang] = useState('ms');
  const [i, setI] = useState(() => { const n = parseInt(location.hash.replace('#', ''), 10); return n >= 1 && n <= STEPS.length ? n - 1 : 0; });
  const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const [reduced, setReduced] = useState(!!mq?.matches);
  const [paused, setPaused] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { const h = (e) => setReduced(e.matches); mq?.addEventListener?.('change', h); return () => mq?.removeEventListener?.('change', h); }, []);
  useEffect(() => { history.replaceState(null, '', '#' + (i + 1)); document.documentElement.lang = lang; }, [i, lang]);
  const ui = UI[lang], s = STEPS[i], c = s[lang];
  return (
    <main>
      <header>
        <div className="top"><span className="badge">Fmail 2.0</span>
          <div className="lang" role="group" aria-label="Language">{['ms', 'en'].map(l => <button key={l} aria-pressed={lang === l} onClick={() => setLang(l)}>{l.toUpperCase()}</button>)}</div></div>
        <h1>{ui.title}</h1><p className="sub">{ui.sub}</p>
        <a className="repo" href="https://github.com/farghees/fmail-2.0">{ui.repo}: farghees/fmail-2.0</a>
      </header>
      <section className="stage" aria-label={ui.scene}>
        {failed ? <p className="note">{ui.nowebgl}</p> : <Scene active={s.nodes} flow={s.flow} paused={paused} reduced={reduced} onFail={() => setFailed(true)} />}
        {!failed && <div className="ctrl">{reduced ? <span className="note">{ui.reduced}</span> : <button onClick={() => setPaused(!paused)}>{paused ? ui.play : ui.pause}</button>}</div>}
      </section>
      <nav className="dots" aria-label="Steps">{STEPS.map((x, k) => <button key={x.id} className={k === i ? 'on' : ''} aria-current={k === i} aria-label={`${ui.step} ${k + 1}`} onClick={() => setI(k)}>{k + 1}</button>)}</nav>
      <article className="card">
        <p className="kicker">{ui.step} {i + 1} / {STEPS.length}{s.added && <span className="new">{ui.added}</span>}</p>
        <h2>{c.t}</h2><p className="lead">{c.d}</p>
        {c.code && <><p className="prompt-label">{lang === 'ms' ? 'Taip kepada Instinct' : 'Send to Instinct'}</p><Code text={c.code} ui={ui} /></>}
        <ul>{c.items.map((x, k) => <li key={k}>{x}</li>)}</ul>
        {c.links && <p className="sources">{c.links.map(([label,url])=><a key={url} href={url} target="_blank" rel="noreferrer">{label}</a>)}</p>}
        <div className="nav"><button disabled={i === 0} onClick={() => setI(i - 1)}>{ui.prev}</button><button className="primary" disabled={i === STEPS.length - 1} onClick={() => setI(i + 1)}>{ui.next}</button></div>
      </article>
      <footer>{ui.foot}<p><a href="../source.tar.gz">Fmail live source (AGPL-3.0)</a> · <a href="/setup/tutorial-source.tar.gz">Tutorial React/Three.js source</a></p></footer>
    </main>
  );
}
