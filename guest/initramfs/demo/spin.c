/* spin: busy loop for N seconds (default: forever). */
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv)
{
	long secs = argc > 1 ? atol(argv[1]) : 0;
	time_t end = time(NULL) + secs;
	volatile unsigned long counter = 0;

	printf("spin: pid %d, %s\n", getpid(), secs ? "bounded" : "forever");
	fflush(stdout);
	for (;;) {
		unsigned long i;
		for (i = 0; i < 1000000; i++)
			counter++;
		if (secs && time(NULL) >= end)
			break;
	}
	return 0;
}
