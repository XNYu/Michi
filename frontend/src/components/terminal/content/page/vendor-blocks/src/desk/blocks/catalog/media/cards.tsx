import {Avatar} from '@mantine/core';
import {FileText,MapPin} from 'lucide-react';
import {usePageImage} from '../../../../vendor/michi/components/MarkdownImage';
import type {BlockProps} from '../../types';
import {OUT,Pic,domainOf} from './Picture';
import {L} from '../../../../../shared/i18n';

/** The whole card is the link. Desk never fetches the page, so every word and the picture are what the agent wrote. */
export const LinkBlock=({block}:BlockProps<'link'>)=><a className="desk-link-card" href={block.url} {...OUT}>
 {block.image&&<span className="desk-link-image"><Pic src={block.image} alt=""/></span>}
 <span className="desk-link-body">
  <span className="desk-link-title">{block.title}</span>
  {block.description&&<span className="desk-link-desc">{block.description}</span>}
  <span className="desk-link-site">{block.site||domainOf(block.url)} ↗</span>
 </span>
</a>;

/** A file named by its path, as text: Desk does not open files from a page. */
export const FileBlock=({block}:BlockProps<'file'>)=><div className="desk-file-card">
 <FileText className="desk-card-icon" size={18} aria-hidden="true"/>
 <div className="desk-card-body">
  {block.title&&<p className="desk-card-name">{block.title}</p>}
  <code className="desk-file-path">{block.path}</code>
  {block.note&&<p className="desk-card-note">{block.note}</p>}
 </div>
</div>;

// Michi: ThreadCardBlock left out; Michi draws thread cards itself (desk/page/blocks/threads.tsx).

/** An avatar that is not https, or does not load, gives way to the name's initial. */
export const PersonBlock=({block}:BlockProps<'person'>)=><div className="desk-person-card">
 <Avatar src={usePageImage(block.avatar)} alt={block.name} name={block.name} color="initials" size="lg" radius="xl"
  imageProps={{referrerPolicy:'no-referrer',loading:'lazy',decoding:'async'}}/>
 <div className="desk-card-body">
  <p className="desk-card-name">{block.name}</p>
  {block.role&&<p className="desk-card-meta">{block.role}</p>}
  {block.note&&<p className="desk-card-note">{block.note}</p>}
  {block.links&&<ul className="desk-card-links">{block.links.map((l,i)=><li key={i}><a href={l.url} {...OUT}>{l.label} ↗</a></li>)}</ul>}
 </div>
</div>;

/** Spec 4.1: no map is drawn; the address opens in a maps app (Apple Maps' web address hands over to Google Maps off Apple devices). */
const mapOf=(q:string)=>`https://maps.apple.com/?q=${encodeURIComponent(q)}`;
export const PlaceBlock=({block}:BlockProps<'place'>)=><div className="desk-place-card">
 <MapPin className="desk-card-icon" size={18} aria-hidden="true"/>
 <div className="desk-card-body">
  <p className="desk-card-name">{block.name}</p>
  {block.address&&<p className="desk-card-meta">{block.address}</p>}
  {block.note&&<p className="desk-card-note">{block.note}</p>}
  <ul className="desk-card-links">
   <li><a href={mapOf(block.address||block.name)} {...OUT}>{L('在地图里打开 ↗','Open in maps ↗')}</a></li>
   {block.url&&<li><a href={block.url} {...OUT}>{domainOf(block.url)} ↗</a></li>}
  </ul>
 </div>
</div>;
