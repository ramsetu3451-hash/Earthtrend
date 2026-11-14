import { useState } from 'react';
import TemperatureApp from './TemperatureApp';
import SystemsApp from './SystemsApp';
export default function App(){const [layer,setLayer]=useState('wind');return layer==='temperature'?<TemperatureApp onLayerChange={setLayer}/>:<SystemsApp id={layer} onLayerChange={setLayer}/>}
