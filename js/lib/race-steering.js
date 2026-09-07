// Integrate a progressive steering curve exactly, independent of frame rate.
// Release has no yaw inertia; reversing begins a fresh, precise correction.
export function createRaceSteering() {
  let held=0,sign=0;
  const ramp=.3,floor=.18;
  const integral=t=>{
    const u=Math.min(t/ramp,1);
    return floor*t+(1-floor)*(ramp*(u**3-.5*u**4)+Math.max(0,t-ramp));
  };
  return {
    reset(){held=0;sign=0;},
    step(input,dt,maxRate){
      if(!input){held=0;sign=0;return 0;}
      if(input!==sign){held=0;sign=input;}
      const before=held;held+=dt;
      return sign*maxRate*(integral(held)-integral(before));
    }
  };
}
