
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <string.h>
#include <stdio.h>

#include <netinet/in.h>
#include <net/if.h>

#ifdef __APPLE_CC__
int tun_alloc(char *dev)
{
  int fd = 0;
  int i = 0;
  for(i = 0; i < 255; ++i) {
    char buf[128];
    sprintf(buf, "/dev/tun%d", i);
    printf("try:%s\n", buf);
    if( (fd = open(buf, O_RDWR)) > 0 ) {
      char *slash = strrchr(buf, '/');
      if (slash) {
        strcpy(dev, slash+1);
      } else {
        strcpy(dev, buf);
      }
      return fd; 
    }
  }
  return -1;
}
#else 
#include <sys/ioctl.h>
#include <linux/if_tun.h>


int tun_alloc(char *dev)
{
	struct ifreq ifr;
	int fd, err;

	if( (fd = open("/dev/net/tun", O_RDWR)) < 0 ) {
	 return -1;
	}
	memset(&ifr, 0, sizeof(ifr));
	/* Flags: IFF_TUN   - TUN device (no Ethernet headers) 
	 *        IFF_TAP   - TAP device  
	 *
	 *        IFF_NO_PI - Do not provide packet information  
	 */ 
	ifr.ifr_flags = IFF_TUN; 
	if (*dev) {
	 strncpy(ifr.ifr_name, dev, IFNAMSIZ);
	}
	err = ioctl(fd, TUNSETIFF, &ifr);
	if (err < 0) {
	 close(fd);
	 return err;
	}
	strcpy(dev, ifr.ifr_name);
	return fd;
}              
#endif

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
	snprintf(setup, sizeof(setup), "./setup.%s \"%s\" \"%s\" \"%s\"", argv[3], argv[2], argv[3], dev);
	system(setup);

	seteuid(1000); // UGLY BUT USEFUL The node has to by run as root!!
	char *cp_argv[argc+3];
	cp_argv[0] = argv[1];
	cp_argv[1] = "sashimi.js";
	char tun_fd[16];
	snprintf(tun_fd, sizeof(tun_fd), "%s:%d", dev, fd);
	cp_argv[2] = tun_fd;
	int i;
	for(i = 2; i <= argc;++i) {
		cp_argv[i+1] = argv[i];
	} 
	execvp(argv[1], cp_argv);
}
