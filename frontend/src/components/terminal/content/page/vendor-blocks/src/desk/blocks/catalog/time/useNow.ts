import {useEffect,useState} from 'react';
/** The time, renewed on every minute change: a countdown and a clock only show minutes, and a timer that began mid-minute would be late by up to one. */
export function useNow():number{
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{
    let id:ReturnType<typeof setTimeout>;
    const wait=()=>{id=setTimeout(()=>{setNow(Date.now());wait();},60_000-Date.now()%60_000);};
    wait();return ()=>clearTimeout(id);
  },[]);
  return now;
}
