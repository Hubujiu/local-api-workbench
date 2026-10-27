    globalThis.Event = class {
      constructor(type, options={}) { this.type=String(type);this.cancelable=Boolean(options.cancelable);this.defaultPrevented=false; }
      preventDefault(){if(this.cancelable)this.defaultPrevented=true;}
    };
    globalThis.EventTarget = class {
      constructor(){this.listeners=new Map();}
      addEventListener(type, listener, options={}) {
        if(!listener)return;
        const list=this.listeners.get(String(type)) || [];
        if(!list.some(item=>item.listener===listener))list.push({listener,once:Boolean(options?.once)});
        this.listeners.set(String(type),list);
      }
      removeEventListener(type,listener){this.listeners.set(String(type),(this.listeners.get(String(type)) || []).filter(item=>item.listener!==listener));}
      dispatchEvent(event){
        if(!(event instanceof Event))throw Error('Event expected');
        for(const item of [...(this.listeners.get(event.type) || [])]) {
          if(item.once)this.removeEventListener(event.type,item.listener);
          if(typeof item.listener === 'function')item.listener.call(this,event);
          else item.listener.handleEvent?.(event);
        }
        return !event.defaultPrevented;
      }
    };
