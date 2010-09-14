#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <string.h>
#include <stdio.h>

#include <net/if.h>
#include <sys/ioctl.h>
#include <linux/if_tun.h>


 int tun_alloc(char *dev)
  {
      struct ifreq ifr;
      int fd, err;

      if( (fd = open("/dev/net/tun", O_RDWR)) < 0 )
         return -1;

      memset(&ifr, 0, sizeof(ifr));

      /* Flags: IFF_TUN   - TUN device (no Ethernet headers) 
       *        IFF_TAP   - TAP device  
       *
       *        IFF_NO_PI - Do not provide packet information  
       */ 
      ifr.ifr_flags = IFF_TUN; 
      if( *dev )
         strncpy(ifr.ifr_name, dev, IFNAMSIZ);

      err = ioctl(fd, TUNSETIFF, &ifr);

      if( err < 0 ){
         close(fd);
         return err;
      }
      strcpy(dev, ifr.ifr_name);
      return fd;
  }              
 

int main(int argc, char **argv) {
	char dev[100];
	int  tun_id = 0;
	int  fd = -1;
	for(tun_id = 0; fd < 0 && tun_id < 0xff; ++tun_id) {
		snprintf(dev, sizeof(dev), "tun%d", tun_id);
		fd = tun_alloc(dev);
	}
	printf("allocated:%d:%s\n", fd, dev);
	char setup[1024];
	snprintf(setup, sizeof(setup), "./setup %s", dev);
	system(setup);

	seteuid(1000);	
	char *cp_argv[argc+3];
	cp_argv[0] = "node";
	cp_argv[1] = "sashimi.js";
	char tun_fd[16];
	snprintf(tun_fd, sizeof(tun_fd), "%s:%d", dev, fd);
	cp_argv[2] = tun_fd;
	int i;
	for(i = 1; i <= argc;++i) {
		cp_argv[i+2] = argv[i];
	} 
	execvp("./linux-x86_64/bin/node", cp_argv);


}
