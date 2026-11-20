import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';

/**
 * Numeric input that keeps a local draft while typing. The value is committed on blur or Enter,
 * so users can clear the field or type "0." without the controlled value snapping back.
 * Invalid drafts are flagged and restored on blur.
 */
export function NumberField({value,onCommit,min,max,step,precision,valid,label,...props}:Omit<InputHTMLAttributes<HTMLInputElement>,'value'|'onChange'|'min'|'max'|'step'>&{
  value:number;onCommit:(value:number)=>void;min?:number;max?:number;step?:number;precision?:number;valid?:(value:number)=>boolean;label?:string;
}){
  const format=(n:number)=>Number.isFinite(n)?String(precision!==undefined?Number(n.toFixed(precision)):n):'';
  const [draft,setDraft]=useState(format(value)),focused=useRef(false),cancelled=useRef(false);
  useEffect(()=>{if(!focused.current)setDraft(format(value));},[value,precision]);
  const parsed=draft.trim()===''?NaN:Number(draft);
  const ok=Number.isFinite(parsed)&&(min===undefined||parsed>=min)&&(max===undefined||parsed<=max)&&(!valid||valid(parsed));
  const commit=()=>{if(ok){if(parsed!==value)onCommit(parsed);setDraft(format(parsed));}else setDraft(format(value));};
  return <input {...props} type="number" inputMode="decimal" min={min} max={max} step={step} value={draft} aria-label={label??props['aria-label']} aria-invalid={!ok||undefined}
    className={`${props.className||''} ${ok?'':'is-invalid'}`.trim()}
    onFocus={event=>{focused.current=true;props.onFocus?.(event);}}
    onChange={event=>{setDraft(event.target.value);const next=Number(event.target.value);
      // Spinner arrows and pasted values commit immediately when they are already valid.
      const native=(event.nativeEvent as InputEvent).inputType;
      if(!native&&event.target.value.trim()!==''&&Number.isFinite(next)&&(min===undefined||next>=min)&&(max===undefined||next<=max)&&(!valid||valid(next))&&next!==value)onCommit(next);}}
    onBlur={event=>{
      focused.current=false;
      if(cancelled.current){cancelled.current=false;setDraft(format(value));}
      else commit();
      props.onBlur?.(event);
    }}
    onKeyDown={event=>{
      if(event.key==='Enter'){event.preventDefault();commit();}
      if(event.key==='Escape'){event.preventDefault();cancelled.current=true;event.currentTarget.blur();}
      props.onKeyDown?.(event);
    }}/>;
}
