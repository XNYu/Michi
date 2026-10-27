/** A time block's own heading, which then labels the block (see BlockView's `headed`). */
export const Title=({id,text}:{id:string;text?:string})=>text?<h2 id={id} className="desk-block-title">{text}</h2>:null;
