'use client';
import {useFormStatus} from 'react-dom';
import {Button} from './ui/button';
export function ExtensionSubmit({label}:{label:string}){
 const {pending}=useFormStatus();return <Button variant="outline" disabled={pending}>{pending?'Working — do not resubmit':label}</Button>;
}
