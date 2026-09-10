import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { accountService, createDailyBalanceAPI, createLocalAPI } from './localData.js';
import { createCloudAuth, isOAuthCallbackPath } from './cloudAuth.js';
import { getSupabaseClient } from './supabaseClient.js';
import { createLocalBridge } from './localBridge.js';
import { resolveCalendarProjection } from './calendarProjection.js';
import { sectionFromHash, sectionHash } from './navigation.js';
import AppShell from './components/AppShell.jsx';
import CompleteActivityDialog from './components/CompleteActivityDialog.jsx';
import KnowledgePage from './features/knowledge/KnowledgePage.jsx';
import KnowledgeWorkspace from './features/knowledge/KnowledgeWorkspace.jsx';
import MyPage from './features/account/MyPage.jsx';
import AuthCallback from './features/account/AuthCallback.jsx';
import TodayPage from './features/today/TodayPage.jsx';
import SpringWindPage from './features/springWind/SpringWindPage.jsx';

/* ── constants ───────────────────────────────────────── */
const VTYPES = ['course','review','skill','practice','knowledge','homework'];
const COURSE_PRESETS = ['CS520','CS570'];
const safeType = t => VTYPES.includes(t) ? t : 'course';
const SYNC_WL  = ['pending','syncing','done','failed','skipped'];
const safeSync = s => SYNC_WL.includes(s) ? s : 'pending';
const TC = {
  course:   {c:'#9b8d72',bg:'rgba(200,170,80,.13)',lbl:'课程学习'},
  review:   {c:'#718997',bg:'rgba(96,127,146,.12)',lbl:'复习巩固'},
  skill:    {c:'#738a77',bg:'rgba(95,127,105,.12)',lbl:'技能拓展'},
  practice: {c:'#7f8b6f',bg:'rgba(110,126,86,.12)',lbl:'实践'},
  knowledge:{c:'#968976',bg:'rgba(138,122,98,.12)',lbl:'知识库搭建'},
  homework: {c:'#a08b7a',bg:'rgba(155,122,98,.12)',lbl:'做作业'},
};
const gt = t => TC[safeType(t)] ?? TC.course;
const BARCOLS = ['#d2c4a1','#9bb0a5','#9fb3c1','#bfae97','#c8b29f','#b3aac4','#b0b0b8'];

/* ── normalize ───────────────────────────────────────── */
const normPlayer = p => { if(!p||typeof p!=='object') p={}; return {level:Number(p.level)||1,xp:Number(p.xp)||0,xp_target:p.xp_target!=null?Number(p.xp_target):null,wealth:Number(p.wealth)||0,streak:Number(p.streak)||0,total_done:Number(p.total_done)||0,total_minutes:Number(p.total_minutes)||0}; };
const normQuest = q => { if(!q||typeof q!=='object'||q.id==null) return null; return {id:q.id,title:typeof q.title==='string'&&q.title?q.title:'(无标题)',task_type:safeType(q.task_type),course_name:typeof q.course_name==='string'?q.course_name:'',start:typeof q.start==='string'?q.start:'',end:typeof q.end==='string'?q.end:'',created_at:typeof q.created_at==='string'?q.created_at:'',completed_at:q.completed_at??null,status:typeof q.status==='string'?q.status:'todo',reward_xp:q.reward_xp!=null?Number(q.reward_xp):null,reward_wealth:q.reward_wealth!=null?Number(q.reward_wealth):null,duration_minutes:q.duration_minutes!=null?Number(q.duration_minutes):null,label:q.label??'',calendar_sync_status:safeSync(q.calendar_sync_status),calendar_sync_message:typeof q.calendar_sync_message==='string'?q.calendar_sync_message:''}; };
const normCharts = c => {
  if(!c||typeof c!=='object') return {days:[],day_minutes:[],type_minutes:{},course_minutes:[]};
  return {
    days:Array.isArray(c.days)?c.days.filter(Boolean):[],
    day_minutes:Array.isArray(c.day_minutes)?c.day_minutes.map(Number):[],
    type_minutes:(c.type_minutes&&typeof c.type_minutes==='object')?c.type_minutes:{},
    course_minutes:Array.isArray(c.course_minutes)
      ? c.course_minutes.map(it=>({
          course_name:typeof it?.course_name==='string'&&it.course_name?it.course_name:'未命名课程',
          minutes:Number(it?.minutes)||0,
          sessions:Number(it?.sessions)||0
        }))
      : []
  };
};
const normalize = raw => {
  const s=(raw&&typeof raw==='object')?(raw.data??raw):{};
  return {
    server_time:typeof s.server_time==='string'?s.server_time:'',
    player:normPlayer(s.player),
    quests:Array.isArray(s.quests)?s.quests.map(normQuest).filter(Boolean):[],
    charts:normCharts(s.charts),
    weekly_outline:Array.isArray(s.weekly_outline)?s.weekly_outline:[],
    weekly:s.weekly??null,
    reminders:Array.isArray(s.reminders)?s.reminders:[]
  };
};

/* ── time helpers ────────────────────────────────────── */
const toInput = s => (s??'').replace(' ','T').slice(0,16);
const toAPI   = s => s.replace('T',' ');
const pad2 = n => String(n).padStart(2,'0');
const toLocalInput = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const nowPlus = m => { const d=new Date(Date.now()+m*60000); d.setSeconds(0,0); return toLocalInput(d); };
const parseT  = s => { if(!s) return null; const[dt,tm]=s.split(' '); if(!dt||!tm) return null; return new Date(`${dt}T${tm}:00`); };
const parseMs = s => {
  if(typeof s!=='string'||!s.trim()) return NaN;
  const v = s.trim().replace(' ','T');
  const d1 = new Date(v);
  if(!Number.isNaN(d1.getTime())) return d1.getTime();
  const d2 = new Date(v.length===16?`${v}:00`:v.slice(0,19));
  return d2.getTime();
};
const fmtMs   = ms => { if(ms<=0) return '已结束'; const t=Math.floor(ms/1000),h=Math.floor(t/3600),m=Math.floor((t%3600)/60),s=t%60; return h>0?`${h}小时${m}分`:`${m}分${s<10?'0'+s:s}秒`; };
const fmtAgo  = ms => { if(ms<=0) return '刚刚'; const t=Math.floor(ms/1000),h=Math.floor(t/3600),m=Math.floor((t%3600)/60); return h>0?`${h}小时${m}分`:`${m}分`; };
const fmtTime = s => { if(!s) return ''; const[dt,tm]=s.split(' '); return `${tm??''} ${(dt??'').slice(5)}`; };

/* ── Hand-drawn SVG Icons ────────────────────────────── */

const CandleIcon = ({size=28,animate=true}) => (
  <svg width={size} height={size*1.6} viewBox="0 0 28 44" fill="none" strokeLinecap="round" strokeLinejoin="round">
    {/* glow behind flame */}
    <ellipse cx="14" cy="10" rx="7" ry="8" fill="rgba(240,200,80,.18)"/>
    {/* flame outer */}
    <path className={animate?'flame-anim':''} d="M14 3 C12 7 10 9.5 12.5 13 C13.2 14.2 14.8 14.2 15.5 13 C18 9.5 16 7 14 3Z" fill="#f0c855" stroke="#c89020" strokeWidth="0.7"/>
    {/* flame inner highlight */}
    <path className={animate?'flame-anim':''} d="M14 6 C13.2 8 12.5 9.5 13.5 11.5" stroke="rgba(255,240,180,.8)" strokeWidth="0.8" fill="none"/>
    {/* wick */}
    <line x1="14" y1="13" x2="14" y2="16" stroke="#2a1c06" strokeWidth="1.2"/>
    {/* candle body */}
    <rect x="9" y="16" width="10" height="20" rx="2.5" fill="#fdf5d8" stroke="#c8980c" strokeWidth="1.2"/>
    {/* subtle wax texture lines */}
    <line x1="9" y1="22" x2="19" y2="22" stroke="rgba(200,160,40,.15)" strokeWidth="0.6"/>
    <line x1="9" y1="28" x2="19" y2="28" stroke="rgba(200,160,40,.15)" strokeWidth="0.6"/>
    {/* wax drip left */}
    <path d="M9 19 C7.5 21 7.5 23.5 9 23.5" stroke="#e8d090" strokeWidth="1" fill="none"/>
    {/* wax drip right */}
    <path d="M19 22 C20.5 24 20.5 26.5 19 26.5" stroke="#e8d090" strokeWidth="1" fill="none"/>
    {/* base cup */}
    <path d="M6 36 C6 34.5 22 34.5 22 36 L23 40 C23 41.2 5 41.2 5 40 Z" fill="#c8980c" stroke="#a07010" strokeWidth="1"/>
    {/* cup highlight */}
    <line x1="8" y1="37" x2="20" y2="37" stroke="rgba(255,220,100,.4)" strokeWidth="0.8"/>
    {/* base shadow */}
    <ellipse cx="14" cy="42" rx="9" ry="1.5" fill="rgba(120,80,20,.1)" stroke="none"/>
  </svg>
);

const BookIcon = ({size=22}) => (
  <svg width={size*1.2} height={size} viewBox="0 0 42 34" fill="none" strokeLinecap="round" strokeLinejoin="round">
    {/* left page */}
    <path d="M21 5 C17 4 9.5 5.5 7 8 L7 30 C9.5 28 17 27 21 28Z" fill="#fdf5d8" stroke="#c8980c" strokeWidth="1.2"/>
    {/* right page */}
    <path d="M21 5 C25 4 32.5 5.5 35 8 L35 30 C32.5 28 25 27 21 28Z" fill="#faf0c8" stroke="#c8980c" strokeWidth="1.2"/>
    {/* spine shadow */}
    <path d="M21 5 L21 28" stroke="#a07010" strokeWidth="1.8"/>
    {/* light on cover */}
    <ellipse cx="21" cy="5" rx="4" ry="1.5" fill="rgba(240,210,100,.35)" stroke="none"/>
    {/* left lines */}
    <line x1="11" y1="12" x2="18.5" y2="11.5" stroke="#c8980c" strokeWidth="0.7" opacity=".5"/>
    <line x1="11" y1="16" x2="18.5" y2="15.5" stroke="#c8980c" strokeWidth="0.7" opacity=".5"/>
    <line x1="11" y1="20" x2="18.5" y2="19.5" stroke="#c8980c" strokeWidth="0.7" opacity=".5"/>
    <line x1="11" y1="24" x2="17" y2="23.5" stroke="#c8980c" strokeWidth="0.7" opacity=".4"/>
    {/* right lines */}
    <line x1="23.5" y1="12" x2="31" y2="11.5" stroke="#c8980c" strokeWidth="0.7" opacity=".5"/>
    <line x1="23.5" y1="16" x2="31" y2="15.5" stroke="#c8980c" strokeWidth="0.7" opacity=".5"/>
    <line x1="23.5" y1="20" x2="31" y2="19.5" stroke="#c8980c" strokeWidth="0.7" opacity=".4"/>
    {/* small star on right page */}
    <path d="M28 23 L28.5 24.3 L29.8 24.3 L28.8 25.1 L29.2 26.4 L28 25.6 L26.8 26.4 L27.2 25.1 L26.2 24.3 L27.5 24.3 Z" fill="#c8980c" opacity=".4"/>
  </svg>
);

const WaveDecor = ({width=120,height=18}) => (
  <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} fill="none">
    <path d={`M0 ${height/2} C${width*.1} ${height*.15} ${width*.2} ${height*.85} ${width*.35} ${height/2} C${width*.5} ${height*.15} ${width*.65} ${height*.85} ${width*.8} ${height/2} C${width*.9} ${height*.25} ${width*.95} ${height*.4} ${width} ${height/2}`}
      stroke="rgba(190,148,55,.35)" strokeWidth="1.2" strokeLinecap="round" fill="none"/>
    <path d={`M0 ${height*.65} C${width*.12} ${height*.3} ${width*.25} ${height*.9} ${width*.4} ${height*.6} C${width*.55} ${height*.3} ${width*.7} ${height*.9} ${width*.85} ${height*.6} C${width*.93} ${height*.4} ${width*.97} ${height*.5} ${width} ${height*.6}`}
      stroke="rgba(190,148,55,.18)" strokeWidth="0.8" strokeLinecap="round" fill="none"/>
  </svg>
);

const SparkleDecor = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M8 1 L8.8 6.2 L14 8 L8.8 9.8 L8 15 L7.2 9.8 L2 8 L7.2 6.2 Z" fill="#c8980c" opacity=".6"/>
    <path d="M3 3 L3.4 5.2 L5.5 5.5 L3.4 5.8 L3 8 L2.6 5.8 L0.5 5.5 L2.6 5.2 Z" fill="#e8be40" opacity=".5"/>
  </svg>
);

const LightRaysDecor = () => (
  <svg width="60" height="60" viewBox="0 0 60 60" fill="none" style={{position:'absolute',top:-10,right:10,opacity:.25,pointerEvents:'none'}}>
    {[0,30,60,90,120,150,180,210,240,270,300,330].map((angle,i)=>(
      <line key={i}
        x1="30" y1="30"
        x2={30+Math.cos(angle*Math.PI/180)*28}
        y2={30+Math.sin(angle*Math.PI/180)*28}
        stroke="#c8980c" strokeWidth={i%3===0?"1.2":"0.6"} strokeLinecap="round"/>
    ))}
    <circle cx="30" cy="30" r="4" fill="rgba(240,200,80,.5)" stroke="#c8980c" strokeWidth="0.8"/>
  </svg>
);

const SealStars = () => {
  const hostRef = useRef(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) return;

    let lastAt = 0;
    let starCount = 0;
    const chars = ['✦','✧','✶'];

    const spawn = (x, y) => {
      const el = document.createElement('span');
      el.className = 'seal-star';
      el.dataset.char = chars[(Math.random() * chars.length) | 0];
      const dur = 0.65 + Math.random() * 0.45;
      el.style.setProperty('--x', `${x.toFixed(1)}px`);
      el.style.setProperty('--y', `${y.toFixed(1)}px`);
      el.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 20)}px`);
      el.style.setProperty('--dy', `${Math.round(8 + Math.random() * 14)}px`);
      el.style.setProperty('--sz', `${(6.2 + Math.random() * 6.8).toFixed(1)}px`);
      el.style.setProperty('--dur', `${dur.toFixed(2)}s`);
      el.style.setProperty('--rot', `${Math.round((Math.random() - 0.5) * 140)}deg`);
      el.style.setProperty('--h', `${40 + Math.round(Math.random() * 20)}`);
      host.appendChild(el);
      starCount += 1;

      window.setTimeout(() => {
        if (el.parentNode) {
          el.parentNode.removeChild(el);
          starCount = Math.max(0, starCount - 1);
        }
      }, Math.round(dur * 1000) + 120);
    };

    const onMove = e => {
      const now = performance.now();
      if (now - lastAt < 18) return;
      lastAt = now;
      const rect = host.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      for (let i = 0; i < 2; i += 1) {
        spawn(x + (Math.random() - 0.5) * 10, y + (Math.random() - 0.5) * 10);
      }
      if (starCount > 70) {
        const nodes = host.querySelectorAll('.seal-star');
        for (let i = 0; i < 18 && i < nodes.length; i += 1) nodes[i]?.remove();
        starCount = Math.max(0, starCount - 18);
      }
    };

    const onEnter = () => {
      const rect = host.getBoundingClientRect();
      for (let i = 0; i < 6; i += 1) {
        spawn(rect.width / 2 + (Math.random() - 0.5) * 26, rect.height / 2 + (Math.random() - 0.5) * 26);
      }
    };

    host.addEventListener('mousemove', onMove, { passive: true });
    host.addEventListener('mouseenter', onEnter);
    return () => {
      host.removeEventListener('mousemove', onMove);
      host.removeEventListener('mouseenter', onEnter);
    };
  }, []);

  return <div className="seal-stars" ref={hostRef} aria-hidden="true"/>;
};

const HeaderSealIcon = () => (
  <div className="hdr-seal">
    <svg width="104" height="104" viewBox="0 0 44 44" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 35 L5 17 C10 16 16 17.5 20 20 L20 37 C16 35.5 10 34.5 5 35Z"
        fill="rgba(255,251,232,.82)" stroke="#b88010" strokeWidth="1.2"/>
      <path d="M39 35 L39 17 C34 16 28 17.5 24 20 L24 37 C28 35.5 34 34.5 39 35Z"
        fill="rgba(255,251,232,.72)" stroke="#9870b8" strokeWidth="1.2"/>
      <line x1="9" y1="22" x2="18" y2="21.5" stroke="rgba(160,110,20,.3)" strokeWidth="0.7"/>
      <line x1="9" y1="26" x2="18" y2="25.5" stroke="rgba(160,110,20,.3)" strokeWidth="0.7"/>
      <line x1="9" y1="30" x2="17" y2="29.5" stroke="rgba(160,110,20,.25)" strokeWidth="0.7"/>
      <line x1="26" y1="22" x2="35" y2="21.5" stroke="rgba(130,80,160,.25)" strokeWidth="0.7"/>
      <line x1="26" y1="26" x2="35" y2="25.5" stroke="rgba(130,80,160,.25)" strokeWidth="0.7"/>
      <line x1="26" y1="30" x2="34" y2="29.5" stroke="rgba(130,80,160,.2)" strokeWidth="0.7"/>
      <line x1="22" y1="19" x2="22" y2="37" stroke="#a07010" strokeWidth="1.6"/>
      <rect x="19.5" y="25" width="5" height="11" rx="1.2"
        fill="rgba(255,251,232,.97)" stroke="#c89018" strokeWidth="1.1"/>
      <path d="M19.5 28 Q17.8 30 18.2 32" stroke="rgba(220,160,180,.7)" strokeWidth="1" fill="none"/>
      <line x1="22" y1="25" x2="22" y2="22.5" stroke="#3a2008" strokeWidth="1"/>
      <path className="flame-anim"
        d="M22 12 C20 16 19 19 21 21.5 C21.6 22.3 22.4 22.3 23 21.5 C25 19 24 16 22 12Z"
        fill="#f0b010" opacity="0.9" stroke="none"/>
      <path className="flame-anim"
        d="M22 15 C21 17.5 20.5 19.5 21.5 21 C21.8 21.5 22.2 21.5 22.5 21 C23.5 19.5 23 17.5 22 15Z"
        fill="#fad040" opacity="0.85" stroke="none"/>
      <path className="flame-anim"
        d="M22 18 C21.5 19.5 21.5 20.5 22 21 C22.5 20.5 22.5 19.5 22 18Z"
        fill="rgba(255,252,220,.9)" stroke="none"/>
    </svg>
    <SealStars/>
  </div>
);

/* ── Silk background ─────────────────────────────────── */
const SilkBg = () => {
  return (
    <div className="silk-bg"/>
  );
};

/* ── Toast ───────────────────────────────────────────── */
const Toast = ({msg,type,onDone}) => { useEffect(()=>{const t=setTimeout(onDone,2300);return()=>clearTimeout(t);},[onDone]); return <div className={`toast ${type==='success'?'s':'e'}`}>{msg}</div>; };

/* ── Confirm ─────────────────────────────────────────── */
const Confirm = ({msg,onYes,onNo}) => (
  <div className="covl" onClick={onNo}>
    <div className="cbox" onClick={e=>e.stopPropagation()}>
      <div className="c-ttl">确认删除</div>
      <div className="c-body">{msg}</div>
      <div className="c-btns"><button className="c-yes" onClick={onYes}>确认删除</button><button className="c-no" onClick={onNo}>取消</button></div>
    </div>
  </div>
);

/* ── SectionHeading ──────────────────────────────────── */
const SH = ({icon,children,sub}) => (
  <div className="sh">
    {icon}
    <span className="sh-text">{children}</span>
    {sub&&<span className="sh-sub">{sub}</span>}
    <div className="sh-line"/>
    <WaveDecor width={80} height={14}/>
  </div>
);

/* ── Header ──────────────────────────────────────────── */
const Header = ({player:p={}}) => (
  <div className="hdr">
    <div className="hdr-left">
      <HeaderSealIcon/>
    </div>
    <div className="hdr-stats">
      <div className="gc stat-card">
        <div className="lbl">连续学习</div>
        <div className="val">{p.streak??0}<span className="unit">天</span></div>
      </div>
      <div className="gc stat-card">
        <div className="lbl">总学习时长</div>
        <div className="val">{p.total_minutes??0}<span className="unit">分钟</span></div>
      </div>
    </div>
  </div>
);

/* ── MonthChart ──────────────────────────────────────── */
const COURSE_PALETTE = ['#c4852a','#3d80a8','#4a8f58','#b84f3c','#7050a8','#7a9a2e','#2e8a80','#c06830'];

const MonthChart = ({charts, quests=[]}) => {
  const {days=[],day_minutes=[]} = charts??{};

  // 课程名 → 固定颜色（按首次出现排序）
  const courseColorMap = useMemo(()=>{
    const seen=[];
    for(const q of quests){
      if(q.status!=='done') continue;
      const c=(q.course_name||'').trim();
      if(c&&!seen.includes(c)) seen.push(c);
    }
    const m={};
    seen.forEach((c,i)=>{ m[c]=COURSE_PALETTE[i%COURSE_PALETTE.length]; });
    return m;
  },[quests]);

  // 每天各课程分钟列表（按分钟数降序）
  const dayCourseList = useMemo(()=>{
    const map={};
    for(const q of quests){
      if(q.status!=='done') continue;
      const day=(q.start||'').slice(0,10);
      const c=(q.course_name||'').trim();
      if(!day||!c) continue;
      const mins=Number(q.duration_minutes||0);
      if(!map[day]) map[day]={};
      map[day][c]=(map[day][c]||0)+mins;
    }
    const result={};
    for(const [day,courses] of Object.entries(map)){
      result[day]=Object.entries(courses).sort((a,b)=>b[1]-a[1]);
    }
    return result;
  },[quests]);

  const allRows = days.map((d,i)=>({day:d,minutes:Number(day_minutes[i]??0)}));
  const maxD = Math.max(...allRows.map(r=>r.minutes),1);
  const hasAny = allRows.some(r=>r.minutes>0);

  // 本月出现过的课程（用于图例）
  const usedCourses = Object.keys(courseColorMap).filter(c=>
    allRows.some(r=>(dayCourseList[r.day]??[]).some(([name])=>name===c))
  );

  return (
    <div className="gc month-wrap">
      <SH icon={<SparkleDecor/>}>最近 1 个月学习时长</SH>
      {!hasAny&&<div className="chart-note">暂无数据</div>}
      {hasAny&&(
        <>
          <div className="col-chart">
            {allRows.map(({day,minutes})=>{
              const empty=minutes===0;
              const barH=empty?5:Math.max(4,(minutes/maxD)*90);
              const courses=dayCourseList[day]??[];
              const topCourse=courses[0]?.[0]??null;
              const capColor=topCourse?courseColorMap[topCourse]:null;
              const tipLines=courses.map(([c,m])=>`${c} ${m}m`).join(' / ');
              const title=`${(day??'').slice(5)} ${empty?'未学习':tipLines}`;
              return (
                <div key={day} className="col-item" title={title}>
                  <div className={`col-bar${empty?' col-empty':''}`} style={{height:`${barH}px`}}>
                    {!empty&&capColor&&<div className="col-cap" style={{background:capColor}}/>}
                    {!empty&&courses.length>0&&(
                      <div className="col-breakdown">
                        {courses.map(([c,m])=>(
                          <div key={c} className="col-breakdown-item"
                            style={{color:courseColorMap[c]??'var(--t3)'}}>
                            {m}m
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className={`col-lbl${empty?' col-lbl-empty':''}`}>{(day??'').slice(5)}</div>
                </div>
              );
            })}
          </div>
          {usedCourses.length>0&&(
            <div className="col-legend">
              {usedCourses.map(c=>(
                <span key={c} className="col-legend-item">
                  <span className="col-legend-dot" style={{background:courseColorMap[c]}}/>
                  {c.length>12?c.slice(0,12)+'…':c}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

/* ── CreateForm ──────────────────────────────────────── */
const mkForm = q => {
  const blank={task_type:'course',course_name:'',title:'',start:nowPlus(0),end:nowPlus(60),write_calendar:false};
  if(!q) return blank;
  return {
    ...blank,
    task_type:safeType(q.task_type),
    course_name:q.course_name??'',
    title:q.title??'',
    start:q.start?toInput(q.start):blank.start,
    end:q.end?toInput(q.end):blank.end,
    write_calendar:q.id?false:Boolean(q.write_calendar??q.source_type==='obsidian'),
  };
};

const CreateForm = ({editQuest,onSave,onCancelEdit,recentQuests=[]}) => {
  const isEdit=!!editQuest?.id;
  const isObsidianDraft=!isEdit&&editQuest?.source_type==='obsidian';
  const [f,setF]=useState(()=>mkForm(editQuest));
  const [busy,setBusy]=useState(false);
  const set=(k,v)=>setF(p=>({...p,[k]:v}));
  const openPicker = e => {
    const fn = e?.currentTarget?.showPicker;
    if (typeof fn === 'function') {
      try { fn.call(e.currentTarget); } catch {}
    }
  };
  const recentSource = useMemo(() => (
    (Array.isArray(recentQuests)?recentQuests:[])
      .map(q => ({q,createdMs:parseMs(q?.created_at||q?.start)}))
      .filter(it => Number.isFinite(it.createdMs) && it.createdMs>=Date.now()-5*24*60*60*1000)
      .sort((a,b)=>b.createdMs-a.createdMs)
  ), [recentQuests]);
  const courseTags = useMemo(() => {
    const picked = new Map();
    const key = `${f.course_name??''}`.trim().toLowerCase();
    for (const c of COURSE_PRESETS) {
      const name = `${c??''}`.trim();
      if(!name) continue;
      if(key && !name.toLowerCase().includes(key)) continue;
      picked.set(name.toLowerCase(), name);
    }
    for (const {q} of recentSource) {
      const name = `${q?.course_name??''}`.trim();
      if(!name) continue;
      const low = name.toLowerCase();
      if(key && !low.includes(key)) continue;
      if(picked.has(low)) continue;
      picked.set(low, name);
      if (picked.size>=10) break;
    }
    return Array.from(picked.values());
  }, [recentSource,f.course_name]);
  const titleTags = useMemo(() => {
    const picked = new Map();
    const key = `${f.title??''}`.trim().toLowerCase();
    for (const {q} of recentSource) {
      const title = `${q?.title??''}`.trim();
      if(!title) continue;
      const low = title.toLowerCase();
      if(key && !low.includes(key)) continue;
      if(picked.has(low)) continue;
      picked.set(low, title);
      if (picked.size>=12) break;
    }
    return Array.from(picked.values());
  }, [recentSource,f.title]);
  const applyCourseTag = course_name => set('course_name',course_name);
  const applyTitleTag = title => set('title',title);
  const applyDurationTag = mins => {
    const start = nowPlus(0);
    const end = nowPlus(mins);
    setF(p=>({...p,start,end}));
  };
  useEffect(()=>{
    setF(mkForm(editQuest));
  },[editQuest]);
  const submit=async e=>{
    e.preventDefault(); if(!f.title.trim()) return;
    setBusy(true);
    try{
      const body={task_type:f.task_type,course_name:f.course_name||undefined,title:f.title.trim(),start:toAPI(f.start),end:toAPI(f.end),write_calendar:f.write_calendar};
      await onSave(body);
      if(!isEdit) setF(mkForm(null));
    }finally{
      setBusy(false);
    }
  };
  return (
    <div className="gc form-wrap">
      <SH icon={<BookIcon size={18}/>}>创建学习任务</SH>
      <form onSubmit={submit}>
        <div className="fg"><label className="fl">学习类型</label>
          <select className="fsel" value={f.task_type} onChange={e=>set('task_type',e.target.value)}>
            {VTYPES.map(t=><option key={t} value={t}>{TC[t]?.lbl??t}</option>)}
          </select></div>
        <div className="fg"><label className="fl">课程/技能名称</label>
          <input className="fi" value={f.course_name} onChange={e=>set('course_name',e.target.value)} placeholder="例如 CS584 / Python"/>
          {courseTags.length>0&&(
            <div className="form-tags">
              <div className="form-tags-note">课程标签建议</div>
              <div className="form-tags-list">
                {courseTags.map(course_name=>(
                  <button
                    key={course_name}
                    className="form-tag"
                    type="button"
                    onClick={()=>applyCourseTag(course_name)}
                  >
                    {course_name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="fg"><label className="fl">任务标题</label>
          <input className="fi" value={f.title} onChange={e=>set('title',e.target.value)} placeholder="例如 Module 11：问答与可视化路径" required/>
          {titleTags.length>0&&(
            <div className="form-tags">
              <div className="form-tags-note">标题标签建议</div>
              <div className="form-tags-list">
                {titleTags.map(title=>(
                  <button
                    key={title}
                    className="form-tag"
                    type="button"
                    onClick={()=>applyTitleTag(title)}
                  >
                    {title}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="frow">
          <div className="fg"><label className="fl">开始时间</label>
            <input className="fi" type="datetime-local" value={f.start} onChange={e=>set('start',e.target.value)} onClick={openPicker} required/></div>
          <div className="fg"><label className="fl">结束时间</label>
            <input className="fi" type="datetime-local" value={f.end} onChange={e=>set('end',e.target.value)} onClick={openPicker} required/></div>
        </div>
        <div className="form-tags" style={{marginTop:4}}>
          <div className="form-tags-note">时长快捷标签</div>
          <div className="form-tags-list">
            <button className="form-tag" type="button" onClick={()=>applyDurationTag(60)}>学习一个小时</button>
            <button className="form-tag" type="button" onClick={()=>applyDurationTag(40)}>学习40分钟</button>
          </div>
        </div>
        {!isEdit&&<label className="calendar-plan-choice"><input type="checkbox" checked={f.write_calendar} onChange={e=>set('write_calendar',e.target.checked)}/><span>创建后写入 <strong>Berich · 计划</strong><small>只有点击下方确认按钮后才会写入 Apple 日历</small></span></label>}
        <div className="mode-badge"><span className={`mode-dot ${isEdit?'edit':''}`}/>当前：{isEdit?'修改模式':isObsidianDraft?'Obsidian 待排期':'新建模式'}</div>
        <button className="btn-create" type="submit" disabled={busy}>{busy?'保存中…':isEdit?'保存修改':isObsidianDraft?'确认时间并创建计划':'创建本地任务'}</button>
        {(isEdit||isObsidianDraft)&&<button className="btn-cancel-edit" type="button" onClick={onCancelEdit}>{isEdit?'取消修改':'稍后安排'}</button>}
      </form>
    </div>
  );
};

/* ── Countdown (live) ────────────────────────────────── */
const useNow = (serverTime='') => {
  const [now,setNow]=useState(()=>parseT(serverTime)?.getTime()||Date.now());
  useEffect(()=>{
    const baseNow = parseT(serverTime)?.getTime() || Date.now();
    const startedAt = Date.now();
    setNow(baseNow);
    const t=setInterval(()=>setNow(baseNow + (Date.now()-startedAt)),1000);
    return()=>clearInterval(t);
  },[serverTime]);
  return now;
};

const Countdown = ({quest,serverTime=''}) => {
  const now=useNow(serverTime);
  if(quest.completed_at||quest.status==='done') return <span className="cd-done">已完成</span>;
  const st=parseT(quest.start),en=parseT(quest.end);
  if(!st||!en) return <span className="cd-done">—</span>;
  if(now<st.getTime()) return <span className="cd-upcoming">还有 {fmtMs(st.getTime()-now)}</span>;
  if(now<=en.getTime()) return <span className="cd-active">剩余 {fmtMs(en.getTime()-now)}</span>;
  return <span className="cd-over">已结束</span>;
};

/* ── TaskTable ───────────────────────────────────────── */
const TaskTable = ({quests=[],onComplete,onEdit,onDelete,matchHeight=0,serverTime=''}) => {
  const [flashId,setFlashId]=useState(null);
  const tableHeight=Math.max(320,Math.round(matchHeight||540));
  const handleDone=quest=>{setFlashId(quest.id);setTimeout(()=>setFlashId(null),600);onComplete(quest);};
  return (
    <div className="gc tbl-wrap">
      <SH icon={<BookIcon size={18}/>} sub="统一查看任务、倒计时、日历同步状态，可直接完成、修改、删除">任务与倒计时表</SH>
      <div className="tbl-shell">
        <div className="tbl-scroll" style={{height:tableHeight,maxHeight:tableHeight}}>
          <table>
            <thead><tr><th>类型</th><th>标题</th><th>课程/技能</th><th>时间</th><th>倒计时</th><th>日历</th><th>操作</th></tr></thead>
            <tbody>
              {quests.length===0&&<tr className="empty-row"><td colSpan={7}>暂无任务 — 在左侧表单创建第一个任务</td></tr>}
              {quests.map(q=>{
                const tc=gt(q.task_type),done=!!q.completed_at||q.status==='done';
                return(
                  <tr key={q.id} className={flashId===q.id?'flash-row':''} style={{opacity:done ? .55 : 1}}>
                    <td><span className="type-badge" style={{color:tc.c,background:tc.bg}}>{tc.lbl}</span></td>
                    <td><div className="task-title">{q.title}</div></td>
                    <td>{q.course_name&&<span className="type-badge" style={{color:tc.c,background:tc.bg,fontSize:10}}>{q.course_name}</span>}</td>
                    <td><div className="task-time">{fmtTime(q.start)}</div><div className="task-time">{fmtTime(q.end)}</div>{q.duration_minutes&&<div className="task-dur">({q.duration_minutes}分钟)</div>}</td>
                    <td><Countdown quest={q} serverTime={serverTime}/></td>
                    <td><div>{q.calendar_sync_status==='done'&&<span className="cal-b cal-ok">已同步日历</span>}{q.calendar_sync_status==='failed'&&<span className="cal-b cal-fail">同步失败</span>}{(q.calendar_sync_status==='pending'||q.calendar_sync_status==='syncing')&&<span className="cal-b" style={{color:'var(--gold2)',background:'rgba(178,154,103,.05)',border:'1px solid rgba(178,154,103,.14)'}}>同步中</span>}{q.calendar_sync_status==='skipped'&&<span className="cal-none">未同步</span>}{q.status&&<span className="cal-b" style={{color:'var(--t3)',background:'rgba(120,80,20,.04)',border:'1px solid rgba(120,80,20,.07)'}}>{q.status}</span>}</div></td>
                    <td><div className="act-btns">{!done&&<button className="btn-t btn-done-t" onClick={()=>handleDone(q)}>记录完成</button>}<button className="btn-t btn-edit-t" onClick={()=>onEdit(q)}>修改</button><button className="btn-t btn-del-t" onClick={()=>onDelete(q.id)}>删除</button></div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

/* ── TypeChart ───────────────────────────────────────── */
const TypeChart = ({charts}) => {
  const {type_minutes={}}=charts??{},maxT=Math.max(...Object.values(type_minutes),1);
  return(
    <div className="gc type-chart-wrap">
      <SH icon={<WaveDecor width={30} height={16}/>}>学习类型分布</SH>
      {Object.keys(type_minutes).length===0
        ? <div className="chart-note" style={{fontStyle:'italic'}}>暂无分布数据</div>
        : Object.entries(type_minutes).map(([t,m],i)=>(
            <div key={t} className="bar-row">
              <div className="bar-lbl">{gt(t).lbl}</div>
              <div className="bar-track"><div className="bar-fill" style={{width:`${(m/maxT)*100}%`,background:BARCOLS[i%BARCOLS.length]}}/></div>
              <div className="bar-val">{m}m</div>
            </div>
          ))
      }
    </div>
  );
};

/* ── CourseTagChart ──────────────────────────────────── */
const CourseTagChart = ({charts}) => {
  const {course_minutes=[]} = charts??{};
  const maxC=Math.max(...course_minutes.map(x=>Number(x?.minutes)||0),1);
  return(
    <div className="gc type-chart-wrap">
      <SH icon={<SparkleDecor/>}>课程学习数据标签（最近 30 天）</SH>
      {course_minutes.length===0
        ? <div className="chart-note" style={{fontStyle:'italic'}}>最近 30 天暂无已完成课程数据。</div>
        : course_minutes.slice(0,6).map((item,i)=>{
            const c=item.course_name||'未命名课程';
            const m=Number(item.minutes)||0;
            return <div key={c} className="bar-row" style={{marginTop:3}}>
              <div className="bar-lbl" style={{minWidth:72,fontSize:10}} title={c}>{c.length>10?c.slice(0,10)+'…':c}</div>
              <div className="bar-track" style={{height:6}}><div className="bar-fill" style={{width:`${(m/maxC)*100}%`,background:BARCOLS[i%BARCOLS.length]}}/></div>
              <div className="bar-val">{m}m</div>
            </div>;
          })
      }
    </div>
  );
};

/* ── WeeklyOutline ───────────────────────────────────── */
const WeeklyOutline = ({weekly_outline=[]}) => {
  const render=()=>{
    if(!Array.isArray(weekly_outline)||weekly_outline.length===0) return <div className="day-empty">暂无本周数据</div>;
    return weekly_outline.map((day,idx)=>{
      const tasks=Array.isArray(day?.tasks)?day.tasks:[];
      return(
        <div key={`${day?.date??''}-${idx}`} className="day-block">
          <div className="day-hdr"><span className="day-name">{day?.weekday??`第${idx+1}天`}</span><span className="day-date">{day?.date??''}</span></div>
          {tasks.length===0
            ? <div className="day-empty">暂无任务</div>
            : tasks.map((t,i)=>{
                const done=t?.status==='done'||!!t?.completed_at;
                const sl=done?'done':'upcoming';
                const st=done?'已完成':'待开始';
                const start=t?.start_time??(t?.start?String(t.start).slice(11,16):'');
                const end=t?.end_time??(t?.end?String(t.end).slice(11,16):'');
                return(
                  <div key={i} className="day-task">
                    {(start||end)&&<span className="day-time">{start} – {end}</span>}
                    <span className={`day-st ${sl}`}>{st}</span>
                    {t?.course_name&&<span className="day-course">{t.course_name}</span>}
                    <span className="day-ttl">{t?.title??''}</span>
                  </div>
                );
              })
          }
        </div>
      );
    });
  };
  return(
    <div className="gc weekly-wrap">
      <SH icon={<SparkleDecor/>}>每周学习大纲</SH>
      <div style={{fontSize:11,color:'var(--t3)',marginBottom:12,fontStyle:'italic'}}>按周一到周日查看本周学习安排。</div>
      {render()}
    </div>
  );
};

/* ── FloatReminder ───────────────────────────────────── */
const FloatReminder = ({quests=[],serverTime='',compact=false}) => {
  const now=useNow(serverTime);
  const [mini,setMini]=useState(()=>compact||(typeof window!=='undefined'&&window.matchMedia('(max-width:700px)').matches));
  useEffect(()=>{if(compact)setMini(true);},[compact]);
  const isDone=q=>q?.status==='done'||!!q?.completed_at;
  const active=quests.find(q=>!isDone(q)&&parseT(q.start)?.getTime()<=now&&parseT(q.end)?.getTime()>=now);
  const upcoming=quests.filter(q=>!isDone(q)&&parseT(q.start)?.getTime()>now).sort((a,b)=>parseT(a.start)?.getTime()-parseT(b.start)?.getTime())[0];
  const lastDone=quests.filter(isDone).map(q=>parseT(q.completed_at||q.end||q.start)).filter(Boolean).sort((a,b)=>b.getTime()-a.getTime())[0];
  const cdLabel=active?fmtMs(parseT(active.end).getTime()-now):'—';
  const idleLabel=active?'进行中':(lastDone?fmtAgo(now-lastDone.getTime()):'暂无记录');
  if(compact||mini) return(
    <div className={`float-widget ${compact?'knowledge-compact':''}`}>
      <div className="float-inner" style={{cursor:compact?'default':'pointer'}} onClick={()=>{if(!compact)setMini(false)}}>
        <div className="float-mini">
          <span className="lbl">学习悬浮提醒</span>
          <span className="cd">{active?cdLabel:'无进行中'}</span>
        </div>
      </div>
    </div>
  );
  return(
    <div className="float-widget">
      <div className="float-inner">
        <div className="float-top">
          <div className="float-title">
            <span className="float-title-txt"><CandleIcon size={24} animate={!!active}/>学习悬浮提醒</span>
            <button className="float-min" onClick={()=>setMini(true)}>—</button>
          </div>
          <div className="float-row">
            <div className="float-col"><div className="lbl">本次学习剩余</div><div className={`val ${active?'cd':''}`}>{cdLabel}</div></div>
            <div className="float-col"><div className="lbl">未学习时长</div><div className="val">{idleLabel}</div></div>
          </div>
          <div className="float-divider"/>
          <div className="float-info">
            <div className="info-lbl">当前</div>
            <div className="info-val">{active?.title??'无进行中任务'}</div>
            <div className="info-lbl">下次学习</div>
            <div className="info-val">{upcoming?`${(upcoming.start??'').slice(11,16)} ${upcoming.title??''}`:'暂无待学习任务'}</div>
          </div>
        </div>
      </div>
    </div>
  );
};

/* ── CursorStars ─────────────────────────────────────── */
const CursorStars = () => {
  const hostRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const finePointer = window.matchMedia('(pointer:fine)').matches;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!finePointer || reducedMotion) return;

    let lastX = 0;
    let lastY = 0;
    let lastAt = 0;
    let starCount = 0;
    const STAR_CHARS = ['✦','✧','✶','✹'];

    const spawnStar = (x, y) => {
      const el = document.createElement('span');
      el.className = 'cursor-star';
      const dur = 0.82 + Math.random() * 0.62;
      el.dataset.char = STAR_CHARS[(Math.random() * STAR_CHARS.length) | 0];
      el.style.setProperty('--x', `${x.toFixed(1)}px`);
      el.style.setProperty('--y', `${y.toFixed(1)}px`);
      el.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 46)}px`);
      el.style.setProperty('--dy', `${Math.round(16 + Math.random() * 34)}px`);
      el.style.setProperty('--sz', `${(5.5 + Math.random() * 9.3).toFixed(1)}px`);
      el.style.setProperty('--dur', `${dur.toFixed(2)}s`);
      el.style.setProperty('--rot', `${Math.round((Math.random() - 0.5) * 180)}deg`);
      el.style.setProperty('--h', `${38 + Math.round(Math.random() * 26)}`);
      host.appendChild(el);
      starCount += 1;

      window.setTimeout(() => {
        if (el.parentNode) {
          el.parentNode.removeChild(el);
          starCount = Math.max(0, starCount - 1);
        }
      }, Math.round(dur * 1000) + 140);
    };

    const onMove = e => {
      const now = performance.now();
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      const dist = Math.hypot(dx, dy);
      if (now - lastAt < 12 && dist < 6) return;

      lastX = e.clientX;
      lastY = e.clientY;
      lastAt = now;

      const burst = dist > 34 ? 5 : 3;
      for (let i = 0; i < burst; i += 1) {
        spawnStar(
          e.clientX + (Math.random() - 0.5) * 24,
          e.clientY + (Math.random() - 0.5) * 18
        );
      }

      // Hard cap to avoid node buildup during long sessions.
      if (starCount > 220) {
        const nodes = host.querySelectorAll('.cursor-star');
        const removeCount = Math.max(0, nodes.length - 160);
        for (let i = 0; i < removeCount; i += 1) {
          nodes[i]?.remove();
          starCount = Math.max(0, starCount - 1);
        }
      }
    };

    window.addEventListener('mousemove', onMove, { passive: true });
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  return <div className="cursor-stars" ref={hostRef} aria-hidden="true"/>;
};

/* ── Local account ───────────────────────────────────── */
const AuthGate = ({onAuthenticated,cloudEnabled,onGoogleLogin,cloudError}) => {
  const [mode,setMode]=useState('login');
  const [form,setForm]=useState({username:'',password:''});
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const accounts=accountService.list();
  const update=(key,value)=>setForm(current=>({...current,[key]:value}));
  const submit=async event=>{
    event.preventDefault();
    setBusy(true);setError('');
    try{
      const account=mode==='register'
        ? await accountService.register({...form,displayName:form.username})
        : await accountService.login(form);
      accountService.remember(account);
      onAuthenticated(account);
    }catch(err){setError(err?.message||'操作失败，请重试');}
    finally{setBusy(false);}
  };
  const switchMode=next=>{setMode(next);setError('');};
  return(
    <main className="auth-shell">
      <SilkBg/><CursorStars/>
      <section className="auth-ledger" aria-labelledby="auth-title">
        <div className="auth-mark"><HeaderSealIcon/></div>
        <p className="auth-kicker">BE RICH, MY FRIEND</p>
        <h1 id="auth-title">把时间，存成自己的财富</h1>
        <p className="auth-intro">{cloudEnabled ? '你可以使用 Google 登录同步资料；本机账户仍只保存在当前浏览器。' : '你的任务、学习时长与成长记录只保存在当前设备的这个浏览器中。'}</p>
        {cloudEnabled&&<button className="auth-submit auth-google" type="button" onClick={onGoogleLogin}>使用 Google 登录</button>}
        {cloudError&&<p className="auth-error" role="alert">{cloudError}</p>}
        <div className="auth-tabs" role="tablist" aria-label="账户操作">
          <button type="button" className={mode==='login'?'active':''} onClick={()=>switchMode('login')}>登录</button>
          <button type="button" className={mode==='register'?'active':''} onClick={()=>switchMode('register')}>创建本地账户</button>
        </div>
        <form className="auth-form" onSubmit={submit}>
          <label>你的名字<input value={form.username} onChange={event=>update('username',event.target.value)} autoComplete="username" placeholder="中文或英文都可以" required/></label>
          <label>本机密码<input type="password" value={form.password} onChange={event=>update('password',event.target.value)} autoComplete={mode==='register'?'new-password':'current-password'} placeholder={mode==='register'?'至少 4 位':'输入本机密码'} required minLength={4}/></label>
          {error&&<p className="auth-error" role="alert">{error}</p>}
          <button className="auth-submit" type="submit" disabled={busy}>{busy?'请稍候…':mode==='register'?'开始积累':'进入我的财富中心'}</button>
        </form>
        <div className="auth-privacy"><span>✦</span><div><strong>本地优先</strong><small>网站服务器不会收到你的账户、密码或学习记录。清除浏览器数据会同时清除本地账户。</small></div></div>
        {accounts.length>0&&<p className="auth-known">此浏览器已有 {accounts.length} 个本地账户</p>}
      </section>
    </main>
  );
};

const AccountBar = ({account,api,onLogout,onImported}) => {
  const fileRef=useRef(null);
  const exportData=()=>{
    const blob=new Blob([api.exportData()],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');
    link.href=url;link.download=`wealth-center-${account.username}.json`;link.click();
    URL.revokeObjectURL(url);
  };
  const importData=async event=>{
    const file=event.target.files?.[0];
    event.target.value='';
    if(!file) return;
    if(!window.confirm('导入会覆盖当前账户在此浏览器中的学习记录，确定继续吗？')) return;
    try{await api.importData(await file.text());onImported();}
    catch{window.alert('导入失败：请选择有效的财富中心 JSON 数据文件。');}
  };
  return(
    <nav className="account-bar" aria-label="当前本地账户">
      <div><span className="account-dot"/><strong>{account.display_name}</strong><small>@{account.username} · 数据仅存本机</small></div>
      <div className="account-actions">
        <button type="button" onClick={()=>fileRef.current?.click()}>导入数据</button>
        <button type="button" onClick={exportData}>备份数据</button>
        <button type="button" onClick={onLogout}>退出</button>
        <input ref={fileRef} type="file" accept="application/json,.json" onChange={importData} hidden/>
      </div>
    </nav>
  );
};

/* ── App ─────────────────────────────────────────────── */
function App({account,api,dailyAPI,bridge,onLogout}){
  const[data,setData]=useState(null);
  const[loading,setLoad]=useState(true);
  const[toast,setToast]=useState(null);
  const[confirm,setConf]=useState(null);
  const[editQ,setEditQ]=useState(null);
  const[section,setSection]=useState(()=>sectionFromHash(window.location.hash));
  const[completion,setCompletion]=useState(null);
  const[dailyVersion,setDailyVersion]=useState(0);
  const[knowledgeVersion,setKnowledgeVersion]=useState(0);
  const[projectionBusy,setProjectionBusy]=useState(new Set());
  const formPanelRef=useRef(null);
  const [formPanelHeight,setFormPanelHeight]=useState(0);
  const loadSeqRef=useRef(0),mutatingRef=useRef(false);
  const legacyMigrationRef=useRef(false);
  const projectionLocksRef=useRef(new Set());
  const activeRef=useRef(true);
  const toast$=useCallback((msg,type='success')=>setToast({msg,type,k:Date.now()}),[]);

  useEffect(()=>()=>{activeRef.current=false;},[]);

  useEffect(()=>{
    const node=formPanelRef.current;
    if(!node) return;
    const sync=()=>setFormPanelHeight(node.getBoundingClientRect().height||0);
    sync();
    if(typeof ResizeObserver==='undefined'){
      window.addEventListener('resize',sync);
      return()=>window.removeEventListener('resize',sync);
    }
    const ro=new ResizeObserver(sync);
    ro.observe(node);
    window.addEventListener('resize',sync);
    return()=>{ro.disconnect();window.removeEventListener('resize',sync);};
  },[section]);

  const load=useCallback(async(fromMutation=false)=>{
    if(!fromMutation&&mutatingRef.current) return;
    const seq=++loadSeqRef.current;
    try{
      let r=await api.state();
      if(!fromMutation&&!legacyMigrationRef.current){
        legacyMigrationRef.current=true;
        const migrationKey=`wealth-center.legacy-import.${account.id}`;
        let migrationState='';
        try{migrationState=globalThis.localStorage?.getItem(migrationKey)||'';}catch{}
        const localQuests=r?.data?.quests||[];
        if(!migrationState&&localQuests.length===0){
          try{
            const legacy=await bridge.legacyState();
            const legacyData=legacy?.data;
            if(Array.isArray(legacyData?.quests)&&legacyData.quests.length>0){
              await api.importData(legacyData);
              r=await api.state();
              toast$('已恢复之前的学习记录');
            }
            try{globalThis.localStorage?.setItem(migrationKey,'done');}catch{}
          }catch{}
        }else if(!migrationState&&localQuests.length>0){
          try{globalThis.localStorage?.setItem(migrationKey,'skipped_existing');}catch{}
        }
      }
      if(seq!==loadSeqRef.current) return;
      setData(normalize(r));
    }
    catch{if(seq===loadSeqRef.current) toast$('本地数据读取失败','error');}
    finally{if(seq===loadSeqRef.current) setLoad(false);}
  },[account.id,api,bridge,toast$]);

  useEffect(()=>{load();},[load]);
  useEffect(()=>{const t=setInterval(load,30000);return()=>clearInterval(t);},[load]);
  useEffect(()=>{
    const onHash=()=>setSection(sectionFromHash(window.location.hash));
    window.addEventListener('hashchange',onHash);
    return()=>window.removeEventListener('hashchange',onHash);
  },[]);
  useEffect(()=>{
    const h=e=>{if(e.data?.type==='__activate_edit_mode'){}};
    window.addEventListener('message',h);
    window.parent.postMessage({type:'__edit_mode_available'},'*');
    return()=>window.removeEventListener('message',h);
  },[]);

  const withMut=async fn=>{
    mutatingRef.current=true;
    try{
      await fn();
      await load(true);
    }catch(err){
      const msg = err?.message || '操作失败，请稍后重试';
      toast$(msg,'error');
      throw err;
    }finally{
      mutatingRef.current=false;
    }
  };
  const saveQuest=async body=>{
    const editing=!!editQ?.id;
    const sourceTaskKey=editQ?.source_task_key||'';
    let createdQuest=null;
    await withMut(async()=>{
      if(editing){await api.editQ(editQ.id,body);toast$('已更新');}
      else{
        const created=await api.addQ(body);
        createdQuest=created.quest;
        if(sourceTaskKey){await api.removeObsidianTaskDraft(sourceTaskKey);setKnowledgeVersion(value=>value+1);}
        if(!body.write_calendar) toast$('任务已创建 ✦');
      }
      setEditQ(null);
    });
    if(editing||!body.write_calendar||!createdQuest) return;
    const entityId=`quest-plan-${createdQuest.id}`;
    const operationId=entityId;
    const attemptId=`attempt-${globalThis.crypto.randomUUID()}`;
    const event={kind:'plan',title:`学习｜${createdQuest.course_name?`${createdQuest.course_name}｜`:''}${createdQuest.title}`,start:createdQuest.start.replace(' ','T')+':00',end:createdQuest.end.replace(' ','T')+':00'};
    let projectionSaved=false;
    try{
      await dailyAPI.updateProjection(entityId,{operation_id:operationId,attempt_id:attemptId,state:'pending',...event});
      projectionSaved=true;
      const result=await bridge.writeCalendar({...event,operation_id:operationId});
      const questStatus=result.status==='succeeded'?'done':result.status==='pending'?'pending':'failed';
      await dailyAPI.updateProjection(entityId,{operation_id:operationId,attempt_id:attemptId,state:result.status,event_id:result.event_id,...event});
      await api.updateQuestCalendar(createdQuest.id,{status:questStatus,message:result.status,event_id:result.event_id,operation_id:operationId});
      await load(true);setDailyVersion(value=>value+1);
      toast$(result.status==='succeeded'?'任务已创建并写入 Berich · 计划':result.status==='ambiguous'?'任务已创建；日历结果需要核对':'任务已创建；日历稍后可重试',result.status==='succeeded'?'success':'error');
    }catch(error){
      const failure=['permission_denied','unavailable'].includes(error.code)?error.code:error.code==='bridge_unavailable'?'unavailable':'retryable_failure';
      if(projectionSaved) await dailyAPI.updateProjection(entityId,{operation_id:operationId,attempt_id:attemptId,state:failure,...event});
      await api.updateQuestCalendar(createdQuest.id,{status:'failed',message:failure,operation_id:operationId});
      await load(true);setDailyVersion(value=>value+1);
      toast$('任务已保存在本地；当前未写入 Calendar','error');
    }
  };
  const scheduleKnowledgeTask=draft=>{
    setEditQ({...draft,task_type:'course',source_type:'obsidian',source_task_key:draft.source_key,write_calendar:true});
    globalThis.requestAnimationFrame?.(()=>formPanelRef.current?.scrollIntoView({behavior:'smooth',block:'start'}));
  };
  const openQuestCompletion=quest=>setCompletion({
    source_type:'quest', id:quest.id, title:quest.title, kind:'learning',
    planned_duration_minutes:quest.planned_duration_minutes??quest.duration_minutes??25,
  });
  const completeActivity=async details=>{
    if(!completion) return;
    const ended=new Date();
    const started=new Date(ended.getTime()-Number(details.actual_duration_minutes)*60000);
    const actualEnd=toAPI(toLocalInput(ended));
    const actualStart=toAPI(toLocalInput(started));
    const entityId=completion.source_type==='quest'?`quest-${completion.id}`:String(completion.id);
    const operationId=`record-${completion.source_type}-${completion.id}`;
    const attemptId=`attempt-${globalThis.crypto.randomUUID()}`;
    const event={kind:'record',title:`${completion.kind==='body'?'养身':'学习'}｜${completion.title}`,start:actualStart.replace(' ','T')+':00',end:actualEnd.replace(' ','T')+':00'};
    if(completion.source_type==='quest'){
      await withMut(async()=>{
        await api.complQ(completion.id,{...details,actual_start:actualStart,actual_end:actualEnd});
      });
    }else{
      await dailyAPI.recordCompletion({source_id:completion.id,...details,actual_start:actualStart,actual_end:actualEnd,completed_at:actualEnd});
    }
    await dailyAPI.updateProjection(entityId,{operation_id:operationId,attempt_id:attemptId,state:'pending',...event});
    if(!activeRef.current) return;
    let synced=false;
    let syncState='retryable_failure';
    try{
      const result=await bridge.writeCalendar({...event,operation_id:operationId});
      syncState=result.status;
      await dailyAPI.updateProjection(entityId,{operation_id:operationId,attempt_id:attemptId,state:result.status,event_id:result.event_id});
      synced=result.status==='succeeded';
    }catch(error){
      syncState=['permission_denied','unavailable'].includes(error.code)?error.code:error.code==='bridge_unavailable'?'unavailable':'retryable_failure';
      await dailyAPI.updateProjection(entityId,{operation_id:operationId,attempt_id:attemptId,state:syncState});
    }
    if(activeRef.current){
      setDailyVersion(value=>value+1);
      setCompletion(null);
      toast$(synced?'真实记录已保存并写入 Berich · 记录':syncState==='ambiguous'?'真实记录已保存；Calendar 结果需要核对':'真实记录已保存在本地；Calendar 稍后可补写',synced?'success':'error');
    }
  };
  const resolveProjection=async projection=>{
    const operationId=String(projection?.operation_id||'');
    if(!operationId||projectionLocksRef.current.has(operationId)) return;
    if(!projection.kind||!projection.title||!projection.start||!projection.end){toast$('缺少原始事件信息，请回到对应记录处理','error');return;}
    projectionLocksRef.current.add(operationId);
    setProjectionBusy(current=>new Set(current).add(operationId));
    const attemptId=`attempt-${globalThis.crypto.randomUUID()}`;
    const originalState=projection.state;
    const event={kind:projection.kind,title:projection.title,start:projection.start,end:projection.end};
    try{
      await dailyAPI.updateProjection(projection.entity_id,{operation_id:operationId,attempt_id:attemptId,state:'pending',...event});
      if(!activeRef.current) return;
      const {checked,result}=await resolveCalendarProjection(bridge,{...projection,...event});
      await dailyAPI.updateProjection(projection.entity_id,{operation_id:operationId,attempt_id:attemptId,state:result.status,event_id:result.event_id});
      const questMatch=/^quest-plan-(\d+)$/.exec(String(projection.entity_id||''));
      if(questMatch){await api.updateQuestCalendar(Number(questMatch[1]),{status:result.status==='succeeded'?'done':'failed',message:result.status,event_id:result.event_id,operation_id:operationId});await load(true);}
      if(activeRef.current){
        setDailyVersion(value=>value+1);
        if(result.status==='succeeded') toast$('Calendar 已核对并同步');
        else if(result.status==='ambiguous') toast$('发现多条匹配记录，请先在 Calendar 中人工核对','error');
        else if(originalState==='ambiguous'&&checked.status==='retryable_failure'&&checked.matches===0) toast$('没有找到对应事件；现在可再次点击“重试写入”','error');
        else if(result.status==='permission_denied') toast$('Calendar 尚未授权，请先在系统设置中允许访问','error');
        else toast$('Calendar 暂未恢复，未重复创建事件','error');
      }
    }catch(error){
      const failure=['permission_denied','unavailable'].includes(error.code)?error.code:error.code==='bridge_unavailable'?'unavailable':'retryable_failure';
      await dailyAPI.updateProjection(projection.entity_id,{operation_id:operationId,attempt_id:attemptId,state:failure});
      const questMatch=/^quest-plan-(\d+)$/.exec(String(projection.entity_id||''));
      if(questMatch){await api.updateQuestCalendar(Number(questMatch[1]),{status:'failed',message:failure,operation_id:operationId});await load(true);}
      if(activeRef.current){setDailyVersion(value=>value+1);toast$('Calendar 暂不可用，原操作编号已保留','error');}
    }finally{
      projectionLocksRef.current.delete(operationId);
      if(activeRef.current)setProjectionBusy(current=>{const next=new Set(current);next.delete(operationId);return next;});
    }
  };
  const deleteQ=id=>setConf({id,msg:'确定要删除这个任务吗？此操作无法撤销。'});
  const doDelete=async()=>{if(!confirm) return;await withMut(async()=>{await api.delQ(confirm.id);toast$('已删除');});setConf(null);};

  if(loading) return(
    <>
      <SilkBg/>
      <div className="spin-wrap">
        <CandleIcon size={40} animate/>
        <div className="ring" style={{marginTop:8}}/>
        <div className="spin-lbl">财富流通中心</div>
      </div>
    </>
  );

  const d=data??{};
  const navigateTo=next=>{window.history.replaceState(null,'',sectionHash(next));setSection(next);};
  const knowledge=(
    <KnowledgePage>
      <div className="page knowledge-ledger">
        <Header player={d.player} serverTime={d.server_time}/>
        <MonthChart charts={d.charts} quests={d.quests??[]}/>
        <div className="mid-grid">
          <div ref={formPanelRef}>
            <CreateForm editQuest={editQ} onSave={saveQuest} onCancelEdit={()=>setEditQ(null)} recentQuests={d.quests??[]}/>
          </div>
          <TaskTable quests={d.quests??[]} onComplete={openQuestCompletion} onEdit={setEditQ} onDelete={deleteQ} matchHeight={formPanelHeight} serverTime={d.server_time}/>
        </div>
        <div className="bot-grid">
          <div style={{display:'grid',gap:16}}>
            <TypeChart charts={d.charts}/>
            <CourseTagChart charts={d.charts}/>
          </div>
          <WeeklyOutline weekly_outline={d.weekly_outline}/>
        </div>
        <KnowledgeWorkspace api={api} dailyAPI={dailyAPI} bridge={bridge} notify={toast$} onScheduleTask={scheduleKnowledgeTask} refreshToken={knowledgeVersion}/>
      </div>
    </KnowledgePage>
  );
  return(
    <>
      <SilkBg/>
      <CursorStars/>
      <AppShell section={section} onSectionChange={setSection} account={account}>
        {section==='today'&&<TodayPage key={`today-${dailyVersion}`} dailyAPI={dailyAPI} bridge={bridge} quests={d.quests??[]} onCompleteActivity={setCompletion} onNavigate={navigateTo} onResolveProjection={resolveProjection} projectionBusy={projectionBusy} notify={toast$}/>} 
        {section==='spring-wind'&&<SpringWindPage dailyAPI={dailyAPI} bridge={bridge} quests={d.quests??[]} notify={toast$}/>} 
        {section==='knowledge'&&knowledge}
        {section==='me'&&<MyPage key={`me-${dailyVersion}`} account={account} api={api} dailyAPI={dailyAPI} bridge={bridge} onResolveProjection={resolveProjection} projectionBusy={projectionBusy} onImported={()=>{load(true);setDailyVersion(value=>value+1);toast$('数据已导入');}} onLogout={onLogout}/>} 
      </AppShell>
      <FloatReminder quests={d.quests??[]} serverTime={d.server_time} compact={section==='knowledge'}/>
      {completion&&<CompleteActivityDialog activity={completion} onCancel={()=>setCompletion(null)} onConfirm={completeActivity}/>} 
      {confirm&&<Confirm msg={confirm.msg} onYes={doDelete} onNo={()=>setConf(null)}/>} 
      {toast&&<Toast key={toast.k} msg={toast.msg} type={toast.type} onDone={()=>setToast(null)}/>} 
    </>
  );
}

const SiteRoot=()=>{
  const cloudClient=useMemo(()=>getSupabaseClient(),[]);
  const cloudAuth=useMemo(()=>createCloudAuth(cloudClient),[cloudClient]);
  const cloudEnabled=Boolean(cloudClient);
  const [cloudState,setCloudState]=useState(()=>cloudEnabled?{status:'booting'}:{status:'disabled'});
  const [cloudError,setCloudError]=useState('');
  const [account,setAccount]=useState(()=>cloudEnabled?null:accountService.restore());
  useEffect(()=>{
    if(!cloudEnabled) return;
    let active=true;
    const apply=next=>{
      if(!active) return;
      setCloudState(next);
      setAccount(next.status==='authenticated'?next.account:null);
    };
    const bootstrap=async()=>{
      try{
        const next=isOAuthCallbackPath(window.location)
          ? await cloudAuth.completeCallback()
          : await cloudAuth.bootstrap();
        apply(next);
      }catch(error){
        if(!active) return;
        setCloudError(error?.message||'Google 登录暂时不可用，请稍后重试');
        setCloudState({status:'error'});
        setAccount(null);
      }
    };
    bootstrap();
    const unsubscribe=cloudAuth.subscribe(next=>apply(next));
    return()=>{active=false;unsubscribe();};
  },[cloudAuth,cloudEnabled]);
  const api=useMemo(()=>account?createLocalAPI(account.id):null,[account]);
  const dailyAPI=useMemo(()=>account?createDailyBalanceAPI(account.id):null,[account]);
  const bridge=useMemo(()=>createLocalBridge(),[]);
  const logout=async()=>{
    if(account?.auth_mode==='google'){
      try{await cloudAuth.signOut();}catch(error){setCloudError(error?.message||'退出 Google 登录失败');}
      setCloudState({status:'anonymous'});
    }else accountService.logout();
    window.history.replaceState(null,'',sectionHash('today'));setAccount(null);
  };
  const authenticate=next=>{window.history.replaceState(null,'',sectionHash('today'));setAccount(next);};
  const loginWithGoogle=async()=>{
    setCloudError('');
    try{await cloudAuth.startGoogleLogin();}
    catch(error){setCloudError(error?.message||'Google 登录暂时不可用，请稍后重试');}
  };
  const returnToLogin=()=>{
    window.history.replaceState(null,'',sectionHash('today'));
    setCloudError('');setCloudState({status:'anonymous'});
  };
  if(cloudEnabled&&isOAuthCallbackPath(window.location)&&(cloudState.status==='booting'||cloudState.status==='error')){
    return <AuthCallback error={cloudState.status==='error'?cloudError:''} onReturnToLogin={returnToLogin}/>;
  }
  if(cloudEnabled&&cloudState.status==='booting') return <AuthCallback/>;
  return account&&api&&dailyAPI
    ? <App key={account.id} account={account} api={api} dailyAPI={dailyAPI} bridge={bridge} onLogout={logout}/>
    : <AuthGate onAuthenticated={authenticate} cloudEnabled={cloudEnabled} onGoogleLogin={loginWithGoogle} cloudError={cloudError}/>;
};

createRoot(document.getElementById('root')).render(<SiteRoot/>);
